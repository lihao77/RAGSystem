import type { TransactionalMemoryRepository } from "../../contracts/memory-store/index.js";
import {
  TenantMemoryCommandService,
  type MemoryCommandService,
} from "./command-service.js";
import {
  TenantMemoryGovernanceService,
  type MemoryGovernanceService,
} from "./governance-service.js";
import { TenantMemoryQueryService, type MemoryQueryService } from "./query-service.js";

export interface MemoryApplication {
  readonly requiresExpectedVersion: boolean;
  query: MemoryQueryService;
  commands: MemoryCommandService;
  governance: MemoryGovernanceService;
}

export function createMemoryApplication(
  tenantId: string,
  repository: TransactionalMemoryRepository,
): MemoryApplication {
  return {
    requiresExpectedVersion: true,
    query: new TenantMemoryQueryService(tenantId, repository),
    commands: new TenantMemoryCommandService(tenantId, repository),
    governance: new TenantMemoryGovernanceService(tenantId, repository),
  };
}
