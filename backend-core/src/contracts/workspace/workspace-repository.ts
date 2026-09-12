import type { TenantId } from "../../identity/types.js";
import type { CreateWorkspaceRecordInput, WorkspaceRecord } from "./workspace.js";

export interface WorkspaceRepositoryPort {
  resolveLocal(input: CreateWorkspaceRecordInput): Promise<WorkspaceRecord>;
  getById(tenantId: TenantId, workspaceId: string): Promise<WorkspaceRecord | null>;
  getByCanonicalKey(tenantId: TenantId, canonicalKey: string): Promise<WorkspaceRecord | null>;
  listByIds(tenantId: TenantId, workspaceIds: readonly string[]): Promise<WorkspaceRecord[]>;
  listAll(tenantId: TenantId): Promise<WorkspaceRecord[]>;
  /** 移除项目：有会话则软删（会话保持绑定，重添同一文件夹即复活），无会话则硬删。 */
  remove(tenantId: TenantId, workspaceId: string): Promise<boolean>;
  /** 重命名（仅 display_name，不影响 root_path / canonical_key）。行不存在或已软删时返回 null。 */
  rename(tenantId: TenantId, workspaceId: string, displayName: string): Promise<WorkspaceRecord | null>;
  updateLocalPath(input: {
    tenantId: TenantId;
    workspaceId: string;
    displayName: string;
    rootPath: string;
    canonicalKey: string;
  }): Promise<WorkspaceRecord | null>;
}
