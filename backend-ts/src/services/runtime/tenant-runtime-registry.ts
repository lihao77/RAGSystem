import path from "node:path";

import type { AppEnv } from "../../config/env.js";
import { createTenantId, type TenantId } from "../../identity/types.js";
import type { AgentExecutionLogger } from "../agent/execution/index.js";
import type { ControlStore } from "../stores/control-store/index.js";
import { createRuntimeContainer, type RuntimeContainer, type RuntimeContainerOptions } from "./runtime-container.js";
import { TenantPaths } from "./tenant-paths.js";

export interface TenantRuntimeLease {
  readonly tenantId: TenantId;
  readonly runtime: RuntimeContainer;
  release(): void;
}

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
  dataRoot: string;
}

export interface TenantRuntimeRegistryOptions {
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
  runtimeOptions?: Omit<RuntimeContainerOptions, "dbPath" | "dataRoot" | "logger">;
  runtimeFactory?: (options: RuntimeContainerOptions) => RuntimeContainer;
}

export interface TenantRuntimeRegistry {
  acquire(tenantId: string): Promise<TenantRuntimeLease>;
  acquireForSession(sessionId: string): Promise<TenantRuntimeLease | null>;
  forTenant(tenantId: string): RuntimeContainer;
  trackWebSocket(tenantId: string): TenantRuntimeActivityLease;
  trackRun(tenantId: string): TenantRuntimeActivityLease;
  snapshot(tenantId: string): TenantRuntimeSnapshot | null;
  closeTenant(tenantId: string): Promise<void>;
  closeAll(): Promise<void>;
}

type RuntimeEntryState = "initializing" | "ready" | "closing" | "closed" | "failed";

interface RuntimeEntry {
  tenantId: TenantId;
  paths: TenantPaths;
  state: RuntimeEntryState;
  container?: RuntimeContainer;
  initPromise: Promise<RuntimeContainer>;
  references: number;
  webSockets: number;
  runs: number;
  lastAccessedAt: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export class DefaultTenantRuntimeRegistry implements TenantRuntimeRegistry {
  private readonly entries = new Map<TenantId, RuntimeEntry>();
  private readonly idleTimeoutMs: number;
  private readonly runtimeFactory: (options: RuntimeContainerOptions) => RuntimeContainer;
  private readonly runtimeOptions: Omit<RuntimeContainerOptions, "dbPath" | "dataRoot" | "logger">;
  private readonly sweepTimer: NodeJS.Timeout;
  private closingAll = false;

  constructor(
    private readonly env: AppEnv,
    private readonly controlStore?: ControlStore,
    private readonly logger?: AgentExecutionLogger,
    options: TenantRuntimeRegistryOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.runtimeFactory = options.runtimeFactory ?? createRuntimeContainer;
    this.runtimeOptions = options.runtimeOptions ?? {};
    const sweepIntervalMs = options.sweepIntervalMs ?? Math.max(1_000, Math.min(this.idleTimeoutMs, 30_000));
    this.sweepTimer = setInterval(() => void this.closeIdleEntries(), sweepIntervalMs);
    this.sweepTimer.unref();
  }

  async acquire(rawTenantId: string): Promise<TenantRuntimeLease> {
    if (this.closingAll) {
      throw new Error("租户运行时注册表正在关闭");
    }
    const tenantId = this.validateTenant(rawTenantId);
    const entry = this.entries.get(tenantId) ?? this.createEntry(tenantId);
    const runtime = await entry.initPromise;
    if (entry.state !== "ready" || entry.container !== runtime) {
      throw new Error(`租户运行时不可用: ${tenantId}`);
    }
    entry.references += 1;
    entry.lastAccessedAt = Date.now();
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

  async acquireForSession(sessionId: string): Promise<TenantRuntimeLease | null> {
    const tenantIds = this.controlStore?.listTenants().map((tenant) => tenant.id) ?? [...this.entries.keys()];
    for (const tenantId of tenantIds) {
      const lease = await this.acquire(tenantId);
      if (lease.runtime.sessionApplication.getSession(sessionId)) return lease;
      lease.release();
    }
    return null;
  }

  forTenant(rawTenantId: string): RuntimeContainer {
    const tenantId = createTenantId(rawTenantId);
    const entry = this.entries.get(tenantId);
    if (!entry?.container || entry.state !== "ready") {
      throw new Error(`租户运行时尚未创建: ${tenantId}`);
    }
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
    if (this.closingAll) return;
    this.closingAll = true;
    clearInterval(this.sweepTimer);
    await Promise.allSettled([...this.entries.values()].map((entry) => this.closeEntry(entry)));
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
          dataRoot: entry.paths.dataRoot,
        }
      : null;
  }

  private validateTenant(rawTenantId: string): TenantId {
    const tenantId = createTenantId(rawTenantId);
    if (this.controlStore && !this.controlStore.getTenant(tenantId)) {
      throw new Error(`租户不存在: ${tenantId}`);
    }
    return tenantId;
  }

  private createEntry(tenantId: TenantId): RuntimeEntry {
    const paths = new TenantPaths(path.join(this.env.tenantsRoot, tenantId));
    const entry: RuntimeEntry = {
      tenantId,
      paths,
      state: "initializing",
      initPromise: Promise.resolve(undefined as never),
      references: 0,
      webSockets: 0,
      runs: 0,
      lastAccessedAt: Date.now(),
    };
    entry.initPromise = Promise.resolve()
      .then(() => {
        const container = this.runtimeFactory({
          ...this.runtimeOptions,
          dbPath: paths.ragsystemDbPath(),
          dataRoot: paths.dataRoot,
          ...(this.logger ? { logger: this.logger } : {}),
        });
        container.backgroundTasks.setOnTaskCompleted((sessionId) => {
          this.forTenant(tenantId).agentExecution.triggerBgNotificationRun(sessionId);
        });
        entry.container = container;
        entry.state = "ready";
        entry.lastAccessedAt = Date.now();
        return container;
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
    if (!entry || entry.state !== "ready") {
      throw new Error(`租户运行时尚未创建: ${tenantId}`);
    }
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

  private async closeEntryIfIdle(entry: RuntimeEntry): Promise<void> {
    this.refreshRunActivity(entry);
    if (entry.state !== "ready" || entry.references > 0 || entry.webSockets > 0 || entry.runs > 0) return;
    if (Date.now() - entry.lastAccessedAt < this.idleTimeoutMs) return;
    await this.closeEntry(entry);
  }

  private refreshRunActivity(entry: RuntimeEntry): void {
    if (entry.container && entry.state === "ready") {
      entry.runs = entry.container.agentExecution.listRunningTasks().count;
    }
  }

  private async closeEntry(entry: RuntimeEntry): Promise<void> {
    if (entry.state === "closed" || entry.state === "closing") return;
    entry.state = "closing";
    try {
      const container = entry.container ?? await entry.initPromise;
      container.close();
    } finally {
      entry.state = "closed";
      this.entries.delete(entry.tenantId);
    }
  }
}
