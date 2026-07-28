import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { AsyncConversationRepository, AsyncRunStore } from "@ragsystem/backend-core/contracts/storage/async-persistence-ports.js";

/** The async, storage-only surface shared by SaaS request handlers. */
export interface SaaSTenantRuntimeHandle {
  readonly tenantId: TenantId;
  readonly conversation: AsyncConversationRepository;
  readonly runs: AsyncRunStore;
  close?(): Promise<void> | void;
}

export interface SaaSTenantRuntimeLease {
  readonly tenantId: TenantId;
  readonly runtime: SaaSTenantRuntimeHandle;
  release(): void;
}

export interface SaaSRuntimeRegistryOptions {
  create(tenantId: TenantId): Promise<SaaSTenantRuntimeHandle> | SaaSTenantRuntimeHandle;
}

/**
 * Tenant-scoped SaaS repository registry.
 *
 * It deliberately owns no filesystem paths and exposes no Local RuntimeContainer
 * methods. Handles are cached while leased and closed when explicitly closed.
 */
export class SaaSRuntimeRegistry {
  private readonly entries = new Map<TenantId, { runtime: SaaSTenantRuntimeHandle; references: number }>();
  private readonly initializing = new Map<TenantId, Promise<SaaSTenantRuntimeHandle>>();
  private closing = false;

  constructor(private readonly options: SaaSRuntimeRegistryOptions) {}

  async acquire(rawTenantId: string): Promise<SaaSTenantRuntimeLease> {
    const tenantId = normalizeTenantId(rawTenantId);
    if (this.closing) throw new Error("SaaS runtime registry is closed");
    let entry = this.entries.get(tenantId);
    if (!entry) {
      let initialization = this.initializing.get(tenantId);
      if (!initialization) {
        initialization = Promise.resolve(this.options.create(tenantId));
        this.initializing.set(tenantId, initialization);
        void initialization.then(
          () => this.initializing.delete(tenantId),
          () => this.initializing.delete(tenantId),
        );
      }
      const runtime = await initialization;
      if (this.closing) {
        await runtime.close?.();
        throw new Error("SaaS runtime registry is closed");
      }
      entry = this.entries.get(tenantId);
      if (!entry) {
        entry = { runtime, references: 0 };
        this.entries.set(tenantId, entry);
      }
    }
    entry.references += 1;
    let released = false;
    return {
      tenantId,
      runtime: entry.runtime,
      release: () => {
        if (released) return;
        released = true;
        entry!.references = Math.max(0, entry!.references - 1);
      },
    };
  }

  async closeTenant(rawTenantId: string): Promise<void> {
    const tenantId = normalizeTenantId(rawTenantId);
    const entry = this.entries.get(tenantId);
    if (!entry) return;
    this.entries.delete(tenantId);
    await entry.runtime.close?.();
  }

  async closeAll(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(async (entry) => entry.runtime.close?.()));
  }

  snapshot(rawTenantId: string): { tenantId: TenantId; references: number } | null {
    const tenantId = normalizeTenantId(rawTenantId);
    const entry = this.entries.get(tenantId);
    return entry ? { tenantId, references: entry.references } : null;
  }
}

function normalizeTenantId(raw: string): TenantId {
  const value = raw.trim();
  if (!value) throw new Error("tenantId is required");
  return value as TenantId;
}
