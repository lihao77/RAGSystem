import type { ToolExecContext } from "@ragsystem/agent-sdk";

import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type {
  RunSandboxRuntime,
  SandboxCodeInput,
  SandboxDriver,
  SandboxEditFileInput,
  SandboxExecInput,
  SandboxGlobInput,
  SandboxGrepInput,
  SandboxLease,
  SandboxLeaseLifecycle,
  SandboxOwner,
  SandboxPreviewFileInput,
  SandboxReadFileInput,
  SandboxWriteFileInput,
} from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";

interface LeaseEntry {
  owner: SandboxOwner;
  leasePromise: Promise<SandboxLease>;
}

/** Tenant-bound run lease registry. A lease can only be retrieved through its full owner identity. */
export class RunSandboxManager implements RunSandboxRuntime {
  private readonly entries = new Map<string, LeaseEntry>();
  private closed = false;

  constructor(
    private readonly tenantId: TenantId,
    private readonly driver: SandboxDriver,
    private readonly timeoutSeconds = 900,
    private readonly lifecycle?: SandboxLeaseLifecycle,
  ) {}

  private async getOrCreate(context: ToolExecContext): Promise<SandboxLease> {
    if (this.closed) throw new Error("Sandbox lease manager is closed");
    const owner = this.resolveOwner(context);
    const key = ownerKey(owner);
    const existing = this.entries.get(key);
    if (existing) {
      assertSameOwner(existing.owner, owner);
      return existing.leasePromise;
    }

    const leasePromise = this.driver.create({
      owner,
      network: "none",
      timeoutSeconds: this.timeoutSeconds,
      filesystem: { input: "read_only", work: "read_write" },
    })
      .then(async (lease) => {
        assertSameOwner(lease.owner, owner);
        try {
          await this.lifecycle?.prepare(lease, owner, this.driver, {
            attachmentFileIds: context.attachmentFileIds ?? [],
          });
        } catch (error) {
          try {
            await this.driver.destroy(lease);
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Sandbox preparation and cleanup failed");
          }
          throw error;
        }
        return lease;
      })
      .catch((error) => {
        if (this.entries.get(key)?.leasePromise === leasePromise) this.entries.delete(key);
        throw error;
    });
    this.entries.set(key, { owner, leasePromise });
    return leasePromise;
  }

  private async withLease<T>(
    context: ToolExecContext,
    operation: (lease: SandboxLease, driver: SandboxDriver) => Promise<T>,
  ): Promise<T> {
    return operation(await this.getOrCreate(context), this.driver);
  }

  async readFile(context: ToolExecContext, input: Omit<SandboxReadFileInput, "signal">) {
    return this.withLease(context, (lease, driver) => driver.readFile(lease, withSignal(input, context.signal)));
  }

  async writeFile(context: ToolExecContext, input: Omit<SandboxWriteFileInput, "signal">) {
    return this.withLease(context, (lease, driver) => driver.writeFile(lease, withSignal(input, context.signal)));
  }

  async editFile(context: ToolExecContext, input: Omit<SandboxEditFileInput, "signal">) {
    return this.withLease(context, (lease, driver) => driver.editFile(lease, withSignal(input, context.signal)));
  }

  async glob(context: ToolExecContext, input: Omit<SandboxGlobInput, "signal">) {
    return this.withLease(context, (lease, driver) => driver.glob(lease, withSignal(input, context.signal)));
  }

  async grep(context: ToolExecContext, input: Omit<SandboxGrepInput, "signal">) {
    return this.withLease(context, (lease, driver) => driver.grep(lease, withSignal(input, context.signal)));
  }

  async previewFile(context: ToolExecContext, input: Omit<SandboxPreviewFileInput, "signal">) {
    return this.withLease(context, (lease, driver) => driver.previewFile(lease, withSignal(input, context.signal)));
  }

  async exec(context: ToolExecContext, input: Omit<SandboxExecInput, "signal">) {
    return this.withLease(context, (lease, driver) => driver.exec(lease, withSignal(input, context.signal)));
  }

  async executeCode(context: ToolExecContext, input: Omit<SandboxCodeInput, "signal">) {
    return this.withLease(context, (lease, driver) => driver.executeCode(lease, withSignal(input, context.signal)));
  }

  private async releaseOwner(owner: SandboxOwner, options: { collectOutputs?: boolean } = {}): Promise<void> {
    if (owner.tenantId !== this.tenantId) throw new Error("Cannot release a sandbox owned by another tenant");
    const key = ownerKey(owner);
    const entry = this.entries.get(key);
    if (!entry) return;
    assertSameOwner(entry.owner, owner);
    this.entries.delete(key);
    const lease = await entry.leasePromise;
    let collectError: unknown;
    try {
      if (options.collectOutputs) await this.lifecycle?.collectOutputs(lease, owner, this.driver);
    } catch (error) {
      collectError = error;
    }
    try {
      await this.driver.destroy(lease);
    } catch (destroyError) {
      if (collectError !== undefined) {
        throw new AggregateError([collectError, destroyError], "Sandbox output collection and cleanup failed");
      }
      throw destroyError;
    }
    if (collectError !== undefined) {
      throw collectError;
    }
  }

  async releaseRun(
    sessionId: string,
    runId: string,
    options: { collectOutputs?: boolean } = {},
  ): Promise<void> {
    const matching = [...this.entries.values()].filter((entry) =>
      entry.owner.sessionId === sessionId && entry.owner.runId === runId,
    );
    const releaseOptions = { collectOutputs: options.collectOutputs ?? true };
    const results = await Promise.allSettled(matching.map((entry) => this.releaseOwner(entry.owner, releaseOptions)));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Sandbox output collection or cleanup failed");
  }

  async closeAll(): Promise<void> {
    if (this.closed && this.entries.size === 0) return;
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    const results = await Promise.allSettled(entries.map(async (entry) => {
      let lease: SandboxLease;
      try {
        lease = await entry.leasePromise;
      } catch {
        return;
      }
      await this.driver.destroy(lease);
    }));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Sandbox cleanup failed");
  }

  private resolveOwner(context: ToolExecContext): SandboxOwner {
    const userId = requiredIdentity(context.userId, "userId");
    const sessionId = requiredIdentity(context.sessionId, "sessionId");
    const runId = requiredIdentity(context.runId, "runId");
    return { tenantId: this.tenantId, userId, sessionId, runId };
  }

}

function withSignal<Input extends object>(
  input: Input,
  signal: AbortSignal | undefined,
): Input & { signal?: AbortSignal | undefined } {
  return signal ? { ...input, signal } : input;
}

function requiredIdentity(value: string | null | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Sandbox execution requires ${label}`);
  return normalized;
}

function ownerKey(owner: SandboxOwner): string {
  return [owner.tenantId, owner.userId, owner.sessionId, owner.runId].map((part) => `${part.length}:${part}`).join("|");
}

function assertSameOwner(actual: SandboxOwner, expected: SandboxOwner): void {
  if (
    actual.tenantId !== expected.tenantId
    || actual.userId !== expected.userId
    || actual.sessionId !== expected.sessionId
    || actual.runId !== expected.runId
  ) {
    throw new Error("Sandbox lease owner mismatch");
  }
}
