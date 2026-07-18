import { MemoryPartitionSchema, type MemoryPartition } from "../../contracts/memory-store/index.js";
import type { MemoryScopePartition } from "./types.js";

export function requireTenantId(tenantId: string): string {
  if (tenantId.trim().length === 0) throw new Error("tenantId must not be empty");
  return tenantId;
}

export function bindMemoryPartition(
  tenantId: string,
  partition: MemoryScopePartition,
): MemoryPartition {
  return MemoryPartitionSchema.parse({ tenant_id: tenantId, ...partition });
}

export function requireMemoryIdentifier(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

