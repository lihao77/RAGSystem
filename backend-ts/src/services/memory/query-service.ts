import type {
  PersistedMemoryEntry,
  PersistedMemoryManagementCountOptions,
  PersistedMemoryManagementListOptions,
  PersistedMemoryListOptions,
  TransactionalMemoryRepository,
} from "../../contracts/memory-store/index.js";
import { bindMemoryPartition, requireMemoryIdentifier, requireTenantId } from "./tenant-boundary.js";
import type { MemoryScopePartition } from "./types.js";

export interface MemoryQueryService {
  getEntry(memoryId: string): Promise<PersistedMemoryEntry | null>;
  listEntries(
    partition: MemoryScopePartition,
    options?: PersistedMemoryListOptions,
  ): Promise<PersistedMemoryEntry[]>;
  getScopeRevision(partition: MemoryScopePartition): Promise<number>;
  listManagedEntries(options: Omit<PersistedMemoryManagementListOptions, "tenant_id">): Promise<PersistedMemoryEntry[]>;
  countManagedEntries(options: Omit<PersistedMemoryManagementCountOptions, "tenant_id">): Promise<number>;
}

export class TenantMemoryQueryService implements MemoryQueryService {
  private readonly tenantId: string;

  constructor(
    tenantId: string,
    private readonly repository: TransactionalMemoryRepository,
  ) {
    this.tenantId = requireTenantId(tenantId);
  }

  getEntry(memoryId: string): Promise<PersistedMemoryEntry | null> {
    return this.repository.getEntry(
      this.tenantId,
      requireMemoryIdentifier(memoryId, "memoryId"),
    );
  }

  listEntries(
    partition: MemoryScopePartition,
    options?: PersistedMemoryListOptions,
  ): Promise<PersistedMemoryEntry[]> {
    const bound = bindMemoryPartition(this.tenantId, partition);
    return options === undefined
      ? this.repository.listEntries(bound)
      : this.repository.listEntries(bound, options);
  }

  getScopeRevision(partition: MemoryScopePartition): Promise<number> {
    return this.repository.getScopeRevision(bindMemoryPartition(this.tenantId, partition));
  }

  listManagedEntries(options: Omit<PersistedMemoryManagementListOptions, "tenant_id">): Promise<PersistedMemoryEntry[]> {
    return this.repository.listManagedEntries({ ...options, tenant_id: this.tenantId });
  }

  countManagedEntries(options: Omit<PersistedMemoryManagementCountOptions, "tenant_id">): Promise<number> {
    return this.repository.countManagedEntries({ ...options, tenant_id: this.tenantId });
  }
}
