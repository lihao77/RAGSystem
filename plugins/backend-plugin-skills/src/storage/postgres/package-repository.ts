import { skillRevisionConflict } from "../../contracts/skills/skill-bundle.js";
import type { CreateSkillPackageBundleInput } from "../../contracts/skills/skill-package-store.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";
import type { SkillsPostgresExecutor } from "./executor.js";

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
  constructor(private readonly executor: SkillsPostgresExecutor) {}

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

  async snapshot(tenantId: TenantId, name: string): Promise<{ row: SkillPackageMetadataRow; files: SkillPackageFileRow[] } | null> {
    return this.withSnapshot(tenantId, name, async (snapshot) => snapshot);
  }

  /** Keep the row's shared lock until the consumer has copied all object bytes. */
  async withSnapshot<T>(tenantId: TenantId, name: string, consume: (snapshot: { row: SkillPackageMetadataRow; files: SkillPackageFileRow[] }) => Promise<T>): Promise<T | null> {
    return this.executor.transaction(async (tx) => {
      const result = await tx.query("SELECT * FROM saas_skill_packages WHERE tenant_id=$1 AND skill_name=$2 FOR SHARE", [tenantId, name]);
      if (!result.rows[0]) return null;
      return consume({ row: toPackageRow(result.rows[0]), files: await new PostgresSkillPackageRepository(tx).listFiles(tenantId, name) });
    });
  }

  async saveBundle(input: {
    tenantId: TenantId; bundle: CreateSkillPackageBundleInput; expectedRevision: string | null;
    contentHash: string; packagePrefix: string;
    files: Array<{ relativePath: string; objectKey: string; contentType: string; sizeBytes: number }>;
  }): Promise<SkillPackageMetadataRow> {
    return this.executor.transaction(async (tx) => {
      const locked = await tx.query("SELECT * FROM saas_skill_packages WHERE tenant_id=$1 AND skill_name=$2 FOR UPDATE", [input.tenantId, input.bundle.name]);
      const current = locked.rows[0];
      if ((current ? String(current.content_hash) : null) !== input.expectedRevision) throw skillRevisionConflict();
      const repo = new PostgresSkillPackageRepository(tx);
      let row: SkillPackageMetadataRow;
      if (!current) {
        try {
          row = await repo.insertPackage({ tenantId: input.tenantId, skillName: input.bundle.name,
            description: input.bundle.description, content: input.bundle.content, metadata: input.bundle.metadata ?? {},
            contentHash: input.contentHash, packagePrefix: input.packagePrefix });
        } catch (error) {
          if (error instanceof Error && error.message.includes("已存在")) throw skillRevisionConflict();
          throw error;
        }
      } else {
        const updated = await tx.query(`UPDATE saas_skill_packages SET description=$3, content=$4, metadata=$5::jsonb,
          content_hash=$6, package_prefix=$7, updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND skill_name=$2 RETURNING *`,
          [input.tenantId, input.bundle.name, input.bundle.description, input.bundle.content, JSON.stringify(input.bundle.metadata ?? {}), input.contentHash, input.packagePrefix]);
        row = toPackageRow(updated.rows[0]!);
        await repo.enqueueGarbage(input.tenantId, (await repo.listFiles(input.tenantId, input.bundle.name)).map((file) => file.object_key));
        await repo.deleteFiles(input.tenantId, input.bundle.name);
      }
      for (const file of input.files) await repo.upsertFile({ ...file, tenantId: input.tenantId, skillName: input.bundle.name });
      return row;
    });
  }

  async deletePackage(tenantId: TenantId, skillName: string, expectedRevision?: string): Promise<boolean> {
    return this.executor.transaction(async (tx) => {
      const locked = await tx.query("SELECT content_hash FROM saas_skill_packages WHERE tenant_id=$1 AND skill_name=$2 FOR UPDATE", [tenantId, skillName]);
      const current = locked.rows[0];
      if (!current) {
        if (expectedRevision !== undefined) throw skillRevisionConflict();
        return false;
      }
      if (expectedRevision !== undefined && String(current.content_hash) !== expectedRevision) throw skillRevisionConflict();
      const repo = new PostgresSkillPackageRepository(tx);
      await repo.enqueueGarbage(tenantId, (await repo.listFiles(tenantId, skillName)).map((file) => file.object_key));
      await tx.query("DELETE FROM saas_skill_packages WHERE tenant_id=$1 AND skill_name=$2", [tenantId, skillName]);
      return true;
    });
  }

  async enqueueGarbage(tenantId: TenantId, objectKeys: readonly string[]): Promise<void> {
    if (!objectKeys.length) return;
    await this.executor.query(
      `INSERT INTO saas_skill_object_garbage(tenant_id, object_key)
       SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [tenantId, objectKeys],
    );
  }

  /** Queue entries survive crashes and failed deletions; workers claim disjoint batches. */
  async reclaimGarbage(tenantId: TenantId, remove: (key: string) => Promise<unknown>): Promise<void> {
    await this.executor.transaction(async (tx) => {
      const batch = await tx.query<{ object_key: string }>(
        `SELECT object_key FROM saas_skill_object_garbage WHERE tenant_id=$1
         ORDER BY attempted_at, object_key LIMIT 256 FOR UPDATE SKIP LOCKED`, [tenantId],
      );
      for (const { object_key: key } of batch.rows) {
        try { await remove(key); }
        catch {
          // Rotate failures to the back so one unavailable prefix cannot starve the queue.
          await tx.query("UPDATE saas_skill_object_garbage SET attempted_at=clock_timestamp() WHERE tenant_id=$1 AND object_key=$2", [tenantId, key]);
          continue;
        }
        await tx.query("DELETE FROM saas_skill_object_garbage WHERE tenant_id=$1 AND object_key=$2", [tenantId, key]);
      }
    });
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
