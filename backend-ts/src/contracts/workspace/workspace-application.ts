import type { TenantId } from "../../identity/types.js";
import type { WorkspaceRecord } from "./workspace.js";

export interface WorkspaceApplication {
  resolveLocalWorkspace(input: { tenantId: TenantId; rootPath: string }): Promise<WorkspaceRecord>;
  getWorkspace(input: { tenantId: TenantId; workspaceId: string }): Promise<WorkspaceRecord | null>;
  listWorkspacesByIds(input: { tenantId: TenantId; workspaceIds: readonly string[] }): Promise<WorkspaceRecord[]>;
}
