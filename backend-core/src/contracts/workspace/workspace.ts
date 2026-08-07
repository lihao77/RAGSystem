import type { TenantId } from "../../identity/types.js";

export interface WorkspaceRecord {
  workspace_id: string;
  tenant_id: TenantId;
  kind: "local";
  display_name: string;
  root_path: string;
  canonical_key: string;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateWorkspaceRecordInput {
  workspaceId: string;
  tenantId: TenantId;
  kind: "local";
  displayName: string;
  rootPath: string;
  canonicalKey: string;
}
