import type { TenantId } from "../../../../identity/types.js";
import type { CreateWorkspaceRecordInput, WorkspaceRecord } from "../../../../contracts/workspace/workspace.js";
import type { ConversationDb } from "./shared/db.js";

export class WorkspaceOps {
  constructor(private readonly db: ConversationDb) {}

  resolveLocal(input: CreateWorkspaceRecordInput): WorkspaceRecord {
    this.db.prepare(`
      INSERT INTO workspaces (workspace_id, tenant_id, kind, display_name, root_path, canonical_key)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, canonical_key) DO NOTHING
    `).run(input.workspaceId, input.tenantId, input.kind, input.displayName, input.rootPath, input.canonicalKey);
    const record = this.getByCanonicalKey(input.tenantId, input.canonicalKey);
    if (!record) throw new Error(`Failed to resolve workspace: ${input.rootPath}`);
    return record;
  }

  getById(tenantId: TenantId, workspaceId: string): WorkspaceRecord | null {
    const row = this.db.prepare(`
      SELECT workspace_id, tenant_id, kind, display_name, root_path, canonical_key, created_at, updated_at
      FROM workspaces WHERE tenant_id=? AND workspace_id=?
    `).get(tenantId, workspaceId) as WorkspaceRecord | undefined;
    return row ?? null;
  }

  getByCanonicalKey(tenantId: TenantId, canonicalKey: string): WorkspaceRecord | null {
    const row = this.db.prepare(`
      SELECT workspace_id, tenant_id, kind, display_name, root_path, canonical_key, created_at, updated_at
      FROM workspaces WHERE tenant_id=? AND canonical_key=?
    `).get(tenantId, canonicalKey) as WorkspaceRecord | undefined;
    return row ?? null;
  }

  listByIds(tenantId: TenantId, workspaceIds: readonly string[]): WorkspaceRecord[] {
    const ids = [...new Set(workspaceIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) return [];
    return this.db.prepare(`
      SELECT workspace_id, tenant_id, kind, display_name, root_path, canonical_key, created_at, updated_at
      FROM workspaces WHERE tenant_id=? AND workspace_id IN (${ids.map(() => "?").join(",")})
    `).all(tenantId, ...ids) as unknown as WorkspaceRecord[];
  }

  updateLocalPath(input: {
    tenantId: TenantId; workspaceId: string; displayName: string; rootPath: string; canonicalKey: string;
  }): WorkspaceRecord | null {
    const result = this.db.prepare(`
      UPDATE workspaces SET display_name=?, root_path=?, canonical_key=?, updated_at=CURRENT_TIMESTAMP
      WHERE tenant_id=? AND workspace_id=? AND kind='local'
    `).run(input.displayName, input.rootPath, input.canonicalKey, input.tenantId, input.workspaceId);
    return Number(result.changes) > 0 ? this.getById(input.tenantId, input.workspaceId) : null;
  }
}
