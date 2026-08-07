import type { TenantId } from "../../identity/types.js";
import type { CreateWorkspaceRecordInput, WorkspaceRecord } from "./workspace.js";

export interface WorkspaceRepositoryPort {
  resolveLocal(input: CreateWorkspaceRecordInput): Promise<WorkspaceRecord>;
  getById(tenantId: TenantId, workspaceId: string): Promise<WorkspaceRecord | null>;
  getByCanonicalKey(tenantId: TenantId, canonicalKey: string): Promise<WorkspaceRecord | null>;
  listByIds(tenantId: TenantId, workspaceIds: readonly string[]): Promise<WorkspaceRecord[]>;
  listAll(tenantId: TenantId): Promise<WorkspaceRecord[]>;
  remove(tenantId: TenantId, workspaceId: string): Promise<boolean>;
  updateLocalPath(input: {
    tenantId: TenantId;
    workspaceId: string;
    displayName: string;
    rootPath: string;
    canonicalKey: string;
  }): Promise<WorkspaceRecord | null>;
}
