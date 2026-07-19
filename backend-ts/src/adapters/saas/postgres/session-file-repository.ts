import type {
  AddSessionFileMetadataInput,
  SessionFileMetadata,
  SessionFileMetadataRepository,
} from "../../../contracts/session/session-file-storage.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

function map(row: Record<string, unknown>): SessionFileMetadata {
  return {
    tenant_id: String(row.tenant_id),
    id: String(row.id),
    original_name: String(row.original_name),
    stored_name: String(row.stored_name),
    stored_path: String(row.storage_key),
    size: Number(row.size),
    mime: String(row.mime),
    uploaded_at: new Date(String(row.uploaded_at)).toISOString(),
    uploaded_by: row.uploaded_by == null ? null : String(row.uploaded_by),
    indexed_in_vector: row.indexed_in_vector === true,
    tags: row.tags == null ? null : String(row.tags),
    notes: row.notes == null ? null : String(row.notes),
    scope_type: "session",
    scope_id: String(row.session_id),
  };
}

export class PostgresSessionFileMetadataRepository implements SessionFileMetadataRepository {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  async list(tenantId: string, sessionId: string): Promise<SessionFileMetadata[]> {
    const result = await this.executor.query("SELECT * FROM session_files WHERE tenant_id=$1 AND session_id=$2 ORDER BY uploaded_at DESC", [tenantId, sessionId]);
    return result.rows.map(map);
  }

  async get(tenantId: string, sessionId: string, fileId: string): Promise<SessionFileMetadata | null> {
    const result = await this.executor.query("SELECT * FROM session_files WHERE tenant_id=$1 AND session_id=$2 AND id=$3", [tenantId, sessionId, fileId]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async create(input: AddSessionFileMetadataInput): Promise<SessionFileMetadata> {
    const result = await this.executor.query(
      "INSERT INTO session_files(tenant_id,session_id,id,original_name,stored_name,storage_key,size,mime,uploaded_at,uploaded_by,indexed_in_vector,tags,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11,$12,$13) RETURNING *",
      [input.tenant_id, input.scope_id, input.id, input.original_name, input.stored_name, input.stored_path, input.size, input.mime, input.uploaded_at, input.uploaded_by, input.indexed_in_vector, input.tags, input.notes],
    );
    if (!result.rows[0]) throw new Error("session file metadata insert returned no row");
    return map(result.rows[0]);
  }

  async delete(tenantId: string, sessionId: string, fileId: string): Promise<boolean> {
    const result = await this.executor.query("DELETE FROM session_files WHERE tenant_id=$1 AND session_id=$2 AND id=$3", [tenantId, sessionId, fileId]);
    return Number(result.rowCount ?? 0) > 0;
  }
}
