import type { ArtifactMetadata, ArtifactMetadataRepository, CreateArtifactMetadataInput } from "../../../contracts/artifacts/artifact-repository.js";
import type { JsonValue } from "../../../contracts/common.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

const map = (row: Record<string, unknown>): ArtifactMetadata => ({
  tenant_id: String(row.tenant_id), artifact_id: String(row.artifact_id), session_id: row.session_id == null ? null : String(row.session_id),
  viz_type: String(row.viz_type), sub_type: String(row.sub_type), title: String(row.title), version: Number(row.version), file_path: String(row.file_path),
  artifact_type: String(row.artifact_type), mime_type: row.mime_type == null ? null : String(row.mime_type), config: (row.config ?? null) as JsonValue | null,
  created_at: new Date(String(row.created_at)).toISOString(), updated_at: new Date(String(row.updated_at)).toISOString(),
});

export class PostgresArtifactMetadataRepository implements ArtifactMetadataRepository {
  constructor(private readonly executor: PostgresMemoryExecutor) {}
  async get(tenantId: string, artifactId: string): Promise<ArtifactMetadata | null> {
    const result = await this.executor.query("SELECT * FROM artifact_metadata WHERE tenant_id=$1 AND artifact_id=$2", [tenantId, artifactId]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async list(tenantId: string, sessionId?: string | null): Promise<ArtifactMetadata[]> {
    const result = sessionId == null
      ? await this.executor.query("SELECT * FROM artifact_metadata WHERE tenant_id=$1 ORDER BY updated_at DESC", [tenantId])
      : await this.executor.query("SELECT * FROM artifact_metadata WHERE tenant_id=$1 AND session_id=$2 ORDER BY updated_at DESC", [tenantId, sessionId]);
    return result.rows.map(map);
  }
  async create(input: CreateArtifactMetadataInput): Promise<ArtifactMetadata> {
    const result = await this.executor.query("INSERT INTO artifact_metadata(tenant_id,artifact_id,session_id,viz_type,sub_type,title,version,file_path,artifact_type,mime_type,config,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,COALESCE($12::timestamptz,CURRENT_TIMESTAMP),COALESCE($13::timestamptz,CURRENT_TIMESTAMP)) RETURNING *", [input.tenant_id, input.artifact_id, input.session_id, input.viz_type, input.sub_type, input.title, input.version, input.file_path, input.artifact_type, input.mime_type, input.config == null ? null : JSON.stringify(input.config), input.created_at ?? null, input.updated_at ?? null]);
    if (!result.rows[0]) throw new Error("artifact metadata insert returned no row");
    return map(result.rows[0]);
  }
  async updateVersion(tenantId: string, artifactId: string, version: number, config?: JsonValue | null): Promise<ArtifactMetadata | null> {
    const result = await this.executor.query("UPDATE artifact_metadata SET version=$1, config=COALESCE($2::jsonb,config), updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$3 AND artifact_id=$4 RETURNING *", [version, config == null ? null : JSON.stringify(config), tenantId, artifactId]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async delete(tenantId: string, artifactId: string): Promise<boolean> {
    const result = await this.executor.query("DELETE FROM artifact_metadata WHERE tenant_id=$1 AND artifact_id=$2", [tenantId, artifactId]);
    return Number(result.rowCount ?? 0) > 0;
  }
}
