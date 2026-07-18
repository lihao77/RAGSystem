import type { TenantId } from "../../identity/types.js";
import type { AsyncConversationRepository } from "../../adapters/saas/postgres/conversation-repository.js";
import type { AsyncRunStore } from "../../adapters/saas/postgres/run-repository.js";

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
  private closing = false;

  constructor(private readonly options: SaaSRuntimeRegistryOptions) {}

  async acquire(rawTenantId: string): Promise<SaaSTenantRuntimeLease> {
    const tenantId = normalizeTenantId(rawTenantId);
    if (this.closing) throw new Error("SaaS runtime registry is closed");
    let entry = this.entries.get(tenantId);
    if (!entry) {
      const runtime = await this.options.create(tenantId);
      if (this.closing) {
        await runtime.close?.();
        throw new Error("SaaS runtime registry is closed");
      }
      entry = { runtime, references: 0 };
      this.entries.set(tenantId, entry);
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
