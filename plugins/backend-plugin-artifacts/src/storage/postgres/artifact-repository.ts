import type {
  ArtifactMetadata,
  ArtifactMetadataRepository,
  CreateArtifactMetadataInput,
} from "../../contracts/artifact-repository.js";
import type { ArtifactStatus } from "../../contracts/artifacts.js";
import type { ArtifactPostgresExecutor } from "./resources.js";

const TABLE = "artifact_metadata_v2";

const map = (row: Record<string, unknown>): ArtifactMetadata => ({
  tenant_id: String(row.tenant_id),
  schema_version: 2,
  artifact_id: String(row.artifact_id),
  session_id: String(row.session_id),
  kind: String(row.kind),
  subtype: String(row.subtype),
  title: String(row.title),
  status: row.status === "failed" ? "failed" : "ready",
  revision: Number(row.revision),
  manifest_path: String(row.manifest_path),
  asset_count: Number(row.asset_count),
  presentation_count: Number(row.presentation_count),
  created_at: new Date(String(row.created_at)).toISOString(),
  updated_at: new Date(String(row.updated_at)).toISOString(),
});

export class PostgresArtifactMetadataRepository implements ArtifactMetadataRepository {
  constructor(private readonly executor: ArtifactPostgresExecutor) {}

  async get(tenantId: string, artifactId: string): Promise<ArtifactMetadata | null> {
    const result = await this.executor.query(`SELECT * FROM ${TABLE} WHERE tenant_id=$1 AND artifact_id=$2`, [tenantId, artifactId]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async list(tenantId: string, sessionId?: string | null): Promise<ArtifactMetadata[]> {
    const result = sessionId == null
      ? await this.executor.query(`SELECT * FROM ${TABLE} WHERE tenant_id=$1 ORDER BY created_at ASC`, [tenantId])
      : await this.executor.query(`SELECT * FROM ${TABLE} WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at ASC`, [tenantId, sessionId]);
    return result.rows.map(map);
  }

  async create(input: CreateArtifactMetadataInput): Promise<ArtifactMetadata> {
    const result = await this.executor.query(
      `INSERT INTO ${TABLE}(tenant_id,artifact_id,session_id,kind,subtype,title,status,revision,manifest_path,asset_count,presentation_count,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::timestamptz,CURRENT_TIMESTAMP),COALESCE($13::timestamptz,CURRENT_TIMESTAMP)) RETURNING *`,
      [input.tenant_id, input.artifact_id, input.session_id, input.kind, input.subtype, input.title, input.status, input.revision, input.manifest_path, input.asset_count, input.presentation_count, input.created_at ?? null, input.updated_at ?? null],
    );
    if (!result.rows[0]) throw new Error("artifact V2 metadata insert returned no row");
    return map(result.rows[0]);
  }

  async updateRevision(input: { tenantId: string; artifactId: string; revision: number; title: string; status: ArtifactStatus; presentationCount: number }): Promise<ArtifactMetadata | null> {
    const result = await this.executor.query(
      `UPDATE ${TABLE} SET revision=$1,title=$2,status=$3,presentation_count=$4,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$5 AND artifact_id=$6 RETURNING *`,
      [input.revision, input.title, input.status, input.presentationCount, input.tenantId, input.artifactId],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async delete(tenantId: string, artifactId: string): Promise<boolean> {
    const result = await this.executor.query(`DELETE FROM ${TABLE} WHERE tenant_id=$1 AND artifact_id=$2`, [tenantId, artifactId]);
    return Number(result.rowCount ?? 0) > 0;
  }
}
