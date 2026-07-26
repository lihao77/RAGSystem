import type { WorkspaceRepositoryPort } from "../../../contracts/workspace/workspace-repository.js";
import type { CreateWorkspaceRecordInput, WorkspaceRecord } from "../../../contracts/workspace/workspace.js";
import type { TenantId } from "../../../identity/types.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

const iso = (value: unknown) => new Date(String(value)).toISOString();

function workspace(row: Record<string, unknown>): WorkspaceRecord {
  return {
    workspace_id: String(row.workspace_id),
    tenant_id: row.tenant_id as TenantId,
    kind: "local",
    display_name: String(row.display_name),
    root_path: String(row.root_path),
    canonical_key: String(row.canonical_key),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export class PostgresWorkspaceRepository implements WorkspaceRepositoryPort {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  async resolveLocal(input: CreateWorkspaceRecordInput): Promise<WorkspaceRecord> {
    const result = await this.executor.query(
      `INSERT INTO conversation_workspaces(
        workspace_id,tenant_id,kind,display_name,root_path,canonical_key
      ) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(tenant_id,canonical_key) DO UPDATE SET
        root_path=EXCLUDED.root_path,
        updated_at=CURRENT_TIMESTAMP
      RETURNING *`,
      [input.workspaceId, input.tenantId, input.kind, input.displayName, input.rootPath, input.canonicalKey],
    );
    if (!result.rows[0]) throw new Error("workspace upsert returned no row");
    return workspace(result.rows[0]);
  }

  async getById(tenantId: TenantId, workspaceId: string): Promise<WorkspaceRecord | null> {
    const result = await this.executor.query(
      "SELECT * FROM conversation_workspaces WHERE tenant_id=$1 AND workspace_id=$2",
      [tenantId, workspaceId],
    );
    return result.rows[0] ? workspace(result.rows[0]) : null;
  }

  async getByCanonicalKey(tenantId: TenantId, canonicalKey: string): Promise<WorkspaceRecord | null> {
    const result = await this.executor.query(
      "SELECT * FROM conversation_workspaces WHERE tenant_id=$1 AND canonical_key=$2",
      [tenantId, canonicalKey],
    );
    return result.rows[0] ? workspace(result.rows[0]) : null;
  }

  async listByIds(tenantId: TenantId, workspaceIds: readonly string[]): Promise<WorkspaceRecord[]> {
    if (workspaceIds.length === 0) return [];
    const result = await this.executor.query(
      "SELECT * FROM conversation_workspaces WHERE tenant_id=$1 AND workspace_id=ANY($2::text[]) ORDER BY display_name,workspace_id",
      [tenantId, workspaceIds],
    );
    return result.rows.map(workspace);
  }

  async updateLocalPath(input: {
    tenantId: TenantId;
    workspaceId: string;
    displayName: string;
    rootPath: string;
    canonicalKey: string;
  }): Promise<WorkspaceRecord | null> {
    const result = await this.executor.query(
      `UPDATE conversation_workspaces SET
        display_name=$3,root_path=$4,canonical_key=$5,updated_at=CURRENT_TIMESTAMP
       WHERE tenant_id=$1 AND workspace_id=$2
       RETURNING *`,
      [input.tenantId, input.workspaceId, input.displayName, input.rootPath, input.canonicalKey],
    );
    return result.rows[0] ? workspace(result.rows[0]) : null;
  }
}
