import type { TransactionalMemoryRepository } from "../../contracts/memory-store/index.js";
import { createTenantId, type TenantId } from "../../identity/types.js";
import { createMemoryApplication, type MemoryApplication } from "../memory/index.js";
import type { RuntimeLease, RuntimeRegistry } from "./tenant-runtime-registry.js";

/**
 * The first SaaS runtime surface is intentionally memory-only. It must not be
 * substituted for RuntimeContainer until the remaining SaaS services exist.
 */
export interface SaaSRuntime {
  readonly tenantId: TenantId;
  readonly memory: MemoryApplication;
}

export type SaaSRuntimeLease = RuntimeLease<SaaSRuntime>;

/**
 * Creates tenant-bound facades over shared SaaS infrastructure. The provider
 * does not own the repository (or its connection pool), so clearing runtime
 * facades never closes shared database resources.
 */
export class SaaSRuntimeProvider implements RuntimeRegistry<SaaSRuntime> {
  private readonly runtimes = new Map<TenantId, SaaSRuntime>();

  constructor(private readonly memoryRepository: TransactionalMemoryRepository) {}

  async acquire(rawTenantId: string): Promise<SaaSRuntimeLease> {
    const tenantId = createTenantId(rawTenantId);
    const runtime = this.runtimes.get(tenantId) ?? this.createRuntime(tenantId);
    let released = false;

    return {
      tenantId,
      runtime,
      release: () => {
        if (released) return;
        released = true;
      },
    };
  }

  async closeTenant(rawTenantId: string): Promise<void> {
    this.runtimes.delete(createTenantId(rawTenantId));
  }

  async closeAll(): Promise<void> {
    this.runtimes.clear();
  }

  private createRuntime(tenantId: TenantId): SaaSRuntime {
    const runtime: SaaSRuntime = {
      tenantId,
      memory: createMemoryApplication(tenantId, this.memoryRepository),
    };
    this.runtimes.set(tenantId, runtime);
    return runtime;
  }
}
