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
  /** 已 stage 进租约的附件集合；增量补齐的判据。 */
  stagedAttachmentIds: Set<string>;
  /** 串行化的补齐链：并发工具调用不得交错 stage；失败不留在链上（见 stageAttachments）。 */
  staging: Promise<void>;
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
    const requested = context.attachmentFileIds ?? [];
    const existing = this.entries.get(key);
    if (existing) {
      assertSameOwner(existing.owner, owner);
      const lease = await existing.leasePromise;
      await this.stageAttachments(existing, lease, requested);
      return lease;
    }

    // 已 stage 集合在 entry 建立时即按本次请求播种：租约链 resolve 之前链外拿不到 lease，
    // prepare 失败时 entry 连同租约一起销毁，不存在"登记了却没 stage"的窗口。
    const leasePromise = this.driver.create({
      owner,
      network: "none",
      timeoutSeconds: this.timeoutSeconds,
      filesystem: { input: "read_only", work: "read_write" },
    })
      .then(async (lease) => {
        assertSameOwner(lease.owner, owner);
        try {
          await this.lifecycle?.prepare(lease, owner, this.driver, { attachmentFileIds: requested });
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
    this.entries.set(key, {
      owner,
      leasePromise,
      stagedAttachmentIds: new Set(requested),
      staging: Promise.resolve(),
    });
    return leasePromise;
  }

  /**
   * 增量 stage：租约一个 owner 只建一次，而运行中补充的用户消息会把新的 file_id 并进
   * execution context（runtime-adapter 认领插嘴时），新增附件必须在下次工具调用前送入沙箱，
   * 否则模型看得到 <attachments> 却读不到文件。已 stage 集合只增不减，重申全量清单保证
   * prepare 清单（如 .ragsystem-manifest.json）始终完整。
   * 失败只让本次工具调用失败：租约里的工作区不销毁（首次 prepare 失败才销毁，见 getOrCreate）。
   */
  private stageAttachments(entry: LeaseEntry, lease: SandboxLease, requested: readonly string[]): Promise<void> {
    if (!this.lifecycle || requested.length === 0) return entry.staging;
    const pending = requested.filter((fileId) => !entry.stagedAttachmentIds.has(fileId));
    if (pending.length === 0) return entry.staging;
    const lifecycle = this.lifecycle;
    const attempt = entry.staging.then(async () => {
      const missing = requested.filter((fileId) => !entry.stagedAttachmentIds.has(fileId));
      if (missing.length === 0) return;
      await lifecycle.prepare(lease, entry.owner, this.driver, {
        attachmentFileIds: [...entry.stagedAttachmentIds, ...missing],
      });
      for (const fileId of missing) entry.stagedAttachmentIds.add(fileId);
    });
    entry.staging = attempt.catch(() => undefined);
    return attempt;
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
