import type { KnowledgeFileMetadataRepository, KnowledgeFileMetadata, AddKnowledgeFileMetadataInput } from "../../../contracts/knowledge/knowledge-file-repository.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

function map(row: Record<string, unknown>): KnowledgeFileMetadata {
  return {
    tenant_id: String(row.tenant_id), id: String(row.id), original_name: String(row.original_name),
    stored_name: String(row.stored_name), stored_path: String(row.stored_path), size: Number(row.size),
    mime: String(row.mime), uploaded_at: new Date(String(row.uploaded_at)).toISOString(),
    md_blob_hash: row.md_blob_hash == null ? null : String(row.md_blob_hash),
  };
}

export class PostgresKnowledgeFileMetadataRepository implements KnowledgeFileMetadataRepository {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  async list(tenantId: string): Promise<KnowledgeFileMetadata[]> {
    const result = await this.executor.query("SELECT * FROM knowledge_files WHERE tenant_id=$1 ORDER BY uploaded_at DESC", [tenantId]);
    return result.rows.map(map);
  }

  async get(tenantId: string, fileId: string): Promise<KnowledgeFileMetadata | null> {
    const result = await this.executor.query("SELECT * FROM knowledge_files WHERE tenant_id=$1 AND id=$2", [tenantId, fileId]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async create(input: AddKnowledgeFileMetadataInput): Promise<KnowledgeFileMetadata> {
    const result = await this.executor.query(
      "INSERT INTO knowledge_files(tenant_id,id,original_name,stored_name,stored_path,size,mime,uploaded_at,md_blob_hash) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,CURRENT_TIMESTAMP),$9) RETURNING *",
      [input.tenant_id, input.id, input.original_name, input.stored_name, input.stored_path, input.size, input.mime, input.uploaded_at ?? null, input.md_blob_hash ?? null],
    );
    if (!result.rows[0]) throw new Error("knowledge file metadata insert returned no row");
    return map(result.rows[0]);
  }

  async setMarkdownHash(tenantId: string, fileId: string, mdBlobHash: string | null): Promise<boolean> {
    const result = await this.executor.query("UPDATE knowledge_files SET md_blob_hash=$1 WHERE tenant_id=$2 AND id=$3", [mdBlobHash, tenantId, fileId]);
    return Number(result.rowCount ?? 0) > 0;
  }

  async delete(tenantId: string, fileId: string): Promise<boolean> {
    const result = await this.executor.query("DELETE FROM knowledge_files WHERE tenant_id=$1 AND id=$2", [tenantId, fileId]);
    return Number(result.rowCount ?? 0) > 0;
  }
}
