import type { TenantId } from "../../../identity/types.js";
import { isRecord } from "../../../utils/guards.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

export interface SkillPackageMetadataRow {
  tenant_id: TenantId;
  skill_name: string;
  description: string;
  content: string;
  metadata: Record<string, unknown>;
  content_hash: string;
  package_prefix: string;
  created_at: string;
  updated_at: string;
}

export interface SkillPackageFileRow {
  tenant_id: TenantId;
  skill_name: string;
  relative_path: string;
  object_key: string;
  content_type: string | null;
  size_bytes: number;
  updated_at: string;
}

/** Low-level PostgreSQL metadata for tenant skill packages. */
export class PostgresSkillPackageRepository {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  async list(tenantId: TenantId): Promise<SkillPackageMetadataRow[]> {
    const result = await this.executor.query(
      "SELECT * FROM saas_skill_packages WHERE tenant_id=$1 ORDER BY skill_name",
      [tenantId],
    );
    return result.rows.map(toPackageRow);
  }

  async get(tenantId: TenantId, skillName: string): Promise<SkillPackageMetadataRow | null> {
    const result = await this.executor.query(
      "SELECT * FROM saas_skill_packages WHERE tenant_id=$1 AND skill_name=$2",
      [tenantId, skillName],
    );
    return result.rows[0] ? toPackageRow(result.rows[0]) : null;
  }

  async insertPackage(input: {
    tenantId: TenantId;
    skillName: string;
    description: string;
    content: string;
    metadata: Record<string, unknown>;
    contentHash: string;
    packagePrefix: string;
  }): Promise<SkillPackageMetadataRow> {
    try {
      const result = await this.executor.query(
        `INSERT INTO saas_skill_packages(
           tenant_id, skill_name, description, content, metadata, content_hash, package_prefix
         ) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
         RETURNING *`,
        [
          input.tenantId,
          input.skillName,
          input.description,
          input.content,
          JSON.stringify(input.metadata),
          input.contentHash,
          input.packagePrefix,
        ],
      );
      return toPackageRow(result.rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(`Skill '${input.skillName}' 已存在`);
      }
      throw error;
    }
  }

  async upsertPackage(input: {
    tenantId: TenantId;
    skillName: string;
    description: string;
    content: string;
    metadata: Record<string, unknown>;
    contentHash: string;
    packagePrefix: string;
  }): Promise<SkillPackageMetadataRow> {
    const result = await this.executor.query(
      `INSERT INTO saas_skill_packages(
         tenant_id, skill_name, description, content, metadata, content_hash, package_prefix
       ) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (tenant_id, skill_name) DO UPDATE SET
         description = EXCLUDED.description,
         content = EXCLUDED.content,
         metadata = EXCLUDED.metadata,
         content_hash = EXCLUDED.content_hash,
         package_prefix = EXCLUDED.package_prefix,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        input.tenantId,
        input.skillName,
        input.description,
        input.content,
        JSON.stringify(input.metadata),
        input.contentHash,
        input.packagePrefix,
      ],
    );
    return toPackageRow(result.rows[0]!);
  }

  async deletePackage(tenantId: TenantId, skillName: string): Promise<boolean> {
    const result = await this.executor.query(
      "DELETE FROM saas_skill_packages WHERE tenant_id=$1 AND skill_name=$2",
      [tenantId, skillName],
    );
    return Number(result.rowCount ?? 0) > 0;
  }

  async listFiles(tenantId: TenantId, skillName: string): Promise<SkillPackageFileRow[]> {
    const result = await this.executor.query(
      "SELECT * FROM saas_skill_package_files WHERE tenant_id=$1 AND skill_name=$2 ORDER BY relative_path",
      [tenantId, skillName],
    );
    return result.rows.map(toFileRow);
  }

  async upsertFile(input: {
    tenantId: TenantId;
    skillName: string;
    relativePath: string;
    objectKey: string;
    contentType: string | null;
    sizeBytes: number;
  }): Promise<SkillPackageFileRow> {
    const result = await this.executor.query(
      `INSERT INTO saas_skill_package_files(
         tenant_id, skill_name, relative_path, object_key, content_type, size_bytes
       ) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, skill_name, relative_path) DO UPDATE SET
         object_key = EXCLUDED.object_key,
         content_type = EXCLUDED.content_type,
         size_bytes = EXCLUDED.size_bytes,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        input.tenantId,
        input.skillName,
        input.relativePath,
        input.objectKey,
        input.contentType,
        input.sizeBytes,
      ],
    );
    return toFileRow(result.rows[0]!);
  }

  async deleteFiles(tenantId: TenantId, skillName: string): Promise<void> {
    await this.executor.query(
      "DELETE FROM saas_skill_package_files WHERE tenant_id=$1 AND skill_name=$2",
      [tenantId, skillName],
    );
  }
}

function toPackageRow(row: Record<string, unknown>): SkillPackageMetadataRow {
  return {
    tenant_id: row.tenant_id as TenantId,
    skill_name: String(row.skill_name),
    description: String(row.description ?? ""),
    content: String(row.content ?? ""),
    metadata: isRecord(row.metadata) ? row.metadata : {},
    content_hash: String(row.content_hash),
    package_prefix: String(row.package_prefix),
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
  };
}

function toFileRow(row: Record<string, unknown>): SkillPackageFileRow {
  return {
    tenant_id: row.tenant_id as TenantId,
    skill_name: String(row.skill_name),
    relative_path: String(row.relative_path),
    object_key: String(row.object_key),
    content_type: row.content_type == null ? null : String(row.content_type),
    size_bytes: Number(row.size_bytes ?? 0),
    updated_at: new Date(String(row.updated_at)).toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "23505",
  );
}
