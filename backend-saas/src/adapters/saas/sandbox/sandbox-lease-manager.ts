import type { ToolExecContext } from "@ragsystem/agent-sdk";

import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { SandboxLease, SandboxLeaseLifecycle, SandboxOwner, SandboxProvider } from "@ragsystem/backend-core/contracts/sandbox/sandbox-provider.js";

interface LeaseEntry {
  owner: SandboxOwner;
  leasePromise: Promise<SandboxLease>;
}

/** Tenant-bound run lease registry. A lease can only be retrieved through its full owner identity. */
export class SandboxLeaseManager {
  private readonly entries = new Map<string, LeaseEntry>();
  private readonly observedSignals = new WeakMap<AbortSignal, Set<string>>();
  private closed = false;

  constructor(
    private readonly tenantId: TenantId,
    private readonly provider: SandboxProvider,
    private readonly timeoutSeconds = 900,
    private readonly lifecycle?: SandboxLeaseLifecycle,
  ) {}

  async getOrCreate(context: ToolExecContext): Promise<SandboxLease> {
    if (this.closed) throw new Error("Sandbox lease manager is closed");
    const owner = this.resolveOwner(context);
    const key = ownerKey(owner);
    const existing = this.entries.get(key);
    if (existing) {
      assertSameOwner(existing.owner, owner);
      this.observeAbort(context.signal, owner);
      return existing.leasePromise;
    }

    const leasePromise = this.provider.create({
      owner,
      network: "none",
      timeoutSeconds: this.timeoutSeconds,
      filesystem: { input: "read_only", work: "read_write" },
    })
      .then(async (lease) => {
        assertSameOwner(lease.owner, owner);
        try {
          await this.lifecycle?.prepare(lease, owner, this.provider, {
            attachmentFileIds: context.attachmentFileIds ?? [],
          });
        } catch (error) {
          await this.provider.destroy(lease).catch(() => undefined);
          throw error;
        }
        return lease;
      })
      .catch((error) => {
        if (this.entries.get(key)?.leasePromise === leasePromise) this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, { owner, leasePromise });
    this.observeAbort(context.signal, owner);
    return leasePromise;
  }

  async withLease<T>(
    context: ToolExecContext,
    operation: (lease: SandboxLease, provider: SandboxProvider) => Promise<T>,
  ): Promise<T> {
    return operation(await this.getOrCreate(context), this.provider);
  }

  async release(context: ToolExecContext): Promise<void> {
    await this.releaseOwner(this.resolveOwner(context));
  }

  async releaseOwner(owner: SandboxOwner, options: { collectOutputs?: boolean } = {}): Promise<void> {
    if (owner.tenantId !== this.tenantId) throw new Error("Cannot release a sandbox owned by another tenant");
    const key = ownerKey(owner);
    const entry = this.entries.get(key);
    if (!entry) return;
    assertSameOwner(entry.owner, owner);
    this.entries.delete(key);
    const lease = await entry.leasePromise;
    try {
      if (options.collectOutputs) await this.lifecycle?.collectOutputs(lease, owner, this.provider);
    } finally {
      await this.provider.destroy(lease);
    }
  }

  async releaseRun(sessionId: string, runId: string): Promise<void> {
    const matching = [...this.entries.values()].filter((entry) =>
      entry.owner.sessionId === sessionId && entry.owner.runId === runId,
    );
    const results = await Promise.allSettled(matching.map((entry) => this.releaseOwner(entry.owner, { collectOutputs: true })));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Sandbox output collection or cleanup failed");
  }

  async closeAll(): Promise<void> {
    if (this.closed && this.entries.size === 0) return;
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map(async (entry) => this.provider.destroy(await entry.leasePromise)));
  }

  private resolveOwner(context: ToolExecContext): SandboxOwner {
    const userId = requiredIdentity(context.userId, "userId");
    const sessionId = requiredIdentity(context.sessionId, "sessionId");
    const runId = requiredIdentity(context.runId, "runId");
    return { tenantId: this.tenantId, userId, sessionId, runId };
  }

  private observeAbort(signal: AbortSignal | undefined, owner: SandboxOwner): void {
    if (!signal) return;
    const key = ownerKey(owner);
    const owners = this.observedSignals.get(signal) ?? new Set<string>();
    if (owners.has(key)) return;
    owners.add(key);
    this.observedSignals.set(signal, owners);
    if (signal.aborted) {
      void this.releaseOwner(owner).catch(() => undefined);
      return;
    }
    signal.addEventListener("abort", () => { void this.releaseOwner(owner).catch(() => undefined); }, { once: true });
  }
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
