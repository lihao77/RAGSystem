import type { TenantDirectory } from "../../contracts/control-plane/index.js";
import type { RuntimeLease, RuntimeRegistry } from "../../contracts/runtime/runtime-provider.js";
import { createTenantId, type TenantId } from "../../identity/types.js";

export type TenantRuntimeLease<TRuntime> = RuntimeLease<TRuntime>;

export interface TenantRuntimeActivityLease {
  release(): void;
}

export interface TenantRuntimeSnapshot {
  tenantId: TenantId;
  state: RuntimeEntryState;
  references: number;
  webSockets: number;
  runs: number;
  lastAccessedAt: number;
}

export interface TenantRuntimeRegistryOptions<TRuntime> {
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
  createRuntime: (tenantId: TenantId) => Promise<TRuntime> | TRuntime;
  prepareRuntime?: (tenantId: TenantId, runtime: TRuntime) => Promise<void>;
  hasSession: (runtime: TRuntime, sessionId: string) => boolean | Promise<boolean>;
  getRunningCount?: (runtime: TRuntime) => number;
  onRuntimeReady?: (tenantId: TenantId, runtime: TRuntime) => Promise<void> | void;
  closeRuntime: (runtime: TRuntime) => Promise<void> | void;
}

export interface TenantRuntimeRegistry<TRuntime> extends RuntimeRegistry<TRuntime> {
  acquireForInspection(tenantId: string): Promise<TenantRuntimeLease<TRuntime>>;
  acquireForSession(sessionId: string): Promise<TenantRuntimeLease<TRuntime> | null>;
  forTenant(tenantId: string): TRuntime;
  trackWebSocket(tenantId: string): TenantRuntimeActivityLease;
  trackRun(tenantId: string): TenantRuntimeActivityLease;
  snapshot(tenantId: string): TenantRuntimeSnapshot | null;
}

export type RuntimeEntryState = "initializing" | "ready" | "closing" | "closed" | "failed";

interface RuntimeEntry<TRuntime> {
  tenantId: TenantId;
  state: RuntimeEntryState;
  container?: TRuntime;
  initPromise: Promise<TRuntime>;
  preparePromise: Promise<void>;
  references: number;
  webSockets: number;
  runs: number;
  lastAccessedAt: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/** Deployment-neutral tenant runtime lifecycle and lease manager. */
export class TenantRuntimeRegistryCore<TRuntime> implements TenantRuntimeRegistry<TRuntime> {
  private readonly entries = new Map<TenantId, RuntimeEntry<TRuntime>>();
  private readonly idleTimeoutMs: number;
  private readonly sweepTimer: NodeJS.Timeout;
  private closingAll = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly tenantDirectory: TenantDirectory | undefined,
    private readonly options: TenantRuntimeRegistryOptions<TRuntime>,
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const sweepIntervalMs = options.sweepIntervalMs ?? Math.max(1_000, Math.min(this.idleTimeoutMs, 30_000));
    this.sweepTimer = setInterval(() => void this.closeIdleEntries(), sweepIntervalMs);
    this.sweepTimer.unref();
  }

  async acquire(rawTenantId: string): Promise<TenantRuntimeLease<TRuntime>> {
    return this.acquireInternal(rawTenantId, false);
  }

  async acquireForInspection(rawTenantId: string): Promise<TenantRuntimeLease<TRuntime>> {
    return this.acquireInternal(rawTenantId, true);
  }

  private async acquireInternal(rawTenantId: string, allowSuspended: boolean): Promise<TenantRuntimeLease<TRuntime>> {
    if (this.closingAll) throw new Error("租户运行时注册表正在关闭");
    const tenantId = await this.validateTenant(rawTenantId, allowSuspended);
    const entry = this.entries.get(tenantId) ?? this.createEntry(tenantId);
    const runtime = await entry.initPromise;
    entry.references += 1;
    entry.lastAccessedAt = Date.now();
    try {
      entry.preparePromise = entry.preparePromise
        .catch(() => undefined)
        .then(() => this.options.prepareRuntime?.(tenantId, runtime));
      await entry.preparePromise;
      if (entry.state !== "ready" || entry.container !== runtime) {
        throw new Error(`租户运行时不可用: ${tenantId}`);
      }
    } catch (error) {
      entry.references = Math.max(0, entry.references - 1);
      entry.lastAccessedAt = Date.now();
      void this.closeEntryIfIdle(entry);
      throw error;
    }
    let released = false;
    return {
      tenantId,
      runtime,
      release: () => {
        if (released) return;
        released = true;
        entry.references = Math.max(0, entry.references - 1);
        entry.lastAccessedAt = Date.now();
        void this.closeEntryIfIdle(entry);
      },
    };
  }

  async acquireForSession(sessionId: string): Promise<TenantRuntimeLease<TRuntime> | null> {
    const tenantIds = this.tenantDirectory
      ? (await this.tenantDirectory.list()).filter((tenant) => tenant.status === "active").map((tenant) => tenant.id)
      : [...this.entries.keys()];
    for (const tenantId of tenantIds) {
      const lease = await this.acquire(tenantId);
      let found = false;
      try {
        found = await this.options.hasSession(lease.runtime, sessionId);
        if (found) return lease;
      } finally {
        if (!found) lease.release();
      }
    }
    return null;
  }

  forTenant(rawTenantId: string): TRuntime {
    const tenantId = createTenantId(rawTenantId);
    const entry = this.entries.get(tenantId);
    if (!entry?.container || entry.state !== "ready") throw new Error(`租户运行时尚未创建: ${tenantId}`);
    entry.lastAccessedAt = Date.now();
    return entry.container;
  }

  trackWebSocket(tenantId: string): TenantRuntimeActivityLease {
    return this.trackActivity(tenantId, "webSockets");
  }

  trackRun(tenantId: string): TenantRuntimeActivityLease {
    return this.trackActivity(tenantId, "runs");
  }

  async closeTenant(rawTenantId: string): Promise<void> {
    const entry = this.entries.get(createTenantId(rawTenantId));
    if (entry) await this.closeEntry(entry);
  }

  async closeAll(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closingAll = true;
    clearInterval(this.sweepTimer);
    this.closePromise = Promise.allSettled([...this.entries.values()].map((entry) => this.closeEntry(entry)))
      .then((results) => {
        const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, "Tenant runtime shutdown failed");
      });
    return this.closePromise;
  }

  snapshot(rawTenantId: string): TenantRuntimeSnapshot | null {
    const tenantId = createTenantId(rawTenantId);
    const entry = this.entries.get(tenantId);
    if (entry) this.refreshRunActivity(entry);
    return entry
      ? {
          tenantId,
          state: entry.state,
          references: entry.references,
          webSockets: entry.webSockets,
          runs: entry.runs,
          lastAccessedAt: entry.lastAccessedAt,
        }
      : null;
  }

  private async validateTenant(rawTenantId: string, allowSuspended: boolean): Promise<TenantId> {
    const tenantId = createTenantId(rawTenantId);
    if (this.tenantDirectory) {
      const tenant = await this.tenantDirectory.get(tenantId);
      if (!tenant) throw new Error(`租户不存在: ${tenantId}`);
      if (!allowSuspended && tenant.status !== "active") throw new Error(`租户已暂停: ${tenantId}`);
    }
    return tenantId;
  }

  private createEntry(tenantId: TenantId): RuntimeEntry<TRuntime> {
    const entry: RuntimeEntry<TRuntime> = {
      tenantId,
      state: "initializing",
      initPromise: Promise.resolve(undefined as never),
      preparePromise: Promise.resolve(),
      references: 0,
      webSockets: 0,
      runs: 0,
      lastAccessedAt: Date.now(),
    };
    entry.initPromise = Promise.resolve()
      .then(() => this.options.createRuntime(tenantId))
      .then(async (runtime) => {
        await this.options.onRuntimeReady?.(tenantId, runtime);
        entry.container = runtime;
        entry.state = "ready";
        entry.lastAccessedAt = Date.now();
        return runtime;
      })
      .catch((error: unknown) => {
        entry.state = "failed";
        this.entries.delete(tenantId);
        throw error;
      });
    this.entries.set(tenantId, entry);
    return entry;
  }

  private trackActivity(rawTenantId: string, field: "webSockets" | "runs"): TenantRuntimeActivityLease {
    const tenantId = createTenantId(rawTenantId);
    const entry = this.entries.get(tenantId);
    if (!entry || entry.state !== "ready") throw new Error(`租户运行时尚未创建: ${tenantId}`);
    entry[field] += 1;
    entry.lastAccessedAt = Date.now();
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        entry[field] = Math.max(0, entry[field] - 1);
        entry.lastAccessedAt = Date.now();
        void this.closeEntryIfIdle(entry);
      },
    };
  }

  private async closeIdleEntries(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map((entry) => this.closeEntryIfIdle(entry)));
  }

  private async closeEntryIfIdle(entry: RuntimeEntry<TRuntime>): Promise<void> {
    this.refreshRunActivity(entry);
    if (entry.state !== "ready" || entry.references > 0 || entry.webSockets > 0 || entry.runs > 0) return;
    if (Date.now() - entry.lastAccessedAt < this.idleTimeoutMs) return;
    await this.closeEntry(entry);
  }

  private refreshRunActivity(entry: RuntimeEntry<TRuntime>): void {
    if (entry.container && entry.state === "ready" && this.options.getRunningCount) {
      entry.runs = this.options.getRunningCount(entry.container);
    }
  }

  private async closeEntry(entry: RuntimeEntry<TRuntime>): Promise<void> {
    if (entry.state === "closed" || entry.state === "closing") return;
    entry.state = "closing";
    try {
      const runtime = entry.container ?? await entry.initPromise;
      await this.options.closeRuntime(runtime);
    } finally {
      entry.state = "closed";
      this.entries.delete(entry.tenantId);
    }
  }
}
