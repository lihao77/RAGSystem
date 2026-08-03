import type { TenantId } from "@ragsystem/backend-core/identity/types.js";

import {
  SkillDraftNameConflictError,
  isSkillDraftNameConflict,
  SkillDraftSchema,
  type SkillDraft,
  type SkillDraftStore,
} from "../../contracts/skills/skill-draft.js";
import type { SkillsPostgresExecutor } from "./executor.js";

export class PostgresSkillDraftStore implements SkillDraftStore {
  constructor(
    private readonly executor: SkillsPostgresExecutor,
    private readonly tenantId: TenantId,
  ) {}

  async list(): Promise<SkillDraft[]> {
    const result = await this.executor.query(
      "SELECT draft FROM saas_skill_drafts WHERE tenant_id=$1 ORDER BY updated_at DESC",
      [this.tenantId],
    );
    return result.rows.map((row) => SkillDraftSchema.parse(row.draft));
  }

  async get(id: string): Promise<SkillDraft | null> {
    const result = await this.executor.query(
      "SELECT draft FROM saas_skill_drafts WHERE tenant_id=$1 AND id=$2",
      [this.tenantId, id],
    );
    return result.rows[0] ? SkillDraftSchema.parse(result.rows[0].draft) : null;
  }

  async create(draft: SkillDraft): Promise<void> {
    const parsed = SkillDraftSchema.parse(draft);
    await this.executor.query(
      `INSERT INTO saas_skill_drafts(tenant_id, id, name, revision, status, draft, updated_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        this.tenantId,
        parsed.id,
        parsed.name,
        parsed.revision,
        parsed.status,
        JSON.stringify(parsed),
        parsed.updated_at,
      ],
    ).catch((error) => {
      if (isSkillDraftNameConflict(error)) throw new SkillDraftNameConflictError();
      throw error;
    });
  }

  async update(expectedRevision: number, draft: SkillDraft): Promise<boolean> {
    const parsed = SkillDraftSchema.parse(draft);
    const result = await this.executor.query(
      `UPDATE saas_skill_drafts
       SET name=$1, revision=$2, status=$3, draft=$4::jsonb, updated_at=$5
       WHERE tenant_id=$6 AND id=$7 AND revision=$8`,
      [
        parsed.name,
        parsed.revision,
        parsed.status,
        JSON.stringify(parsed),
        parsed.updated_at,
        this.tenantId,
        parsed.id,
        expectedRevision,
      ],
    ).catch((error) => {
      if (isSkillDraftNameConflict(error)) throw new SkillDraftNameConflictError();
      throw error;
    });
    return Number(result.rowCount ?? 0) > 0;
  }

  async delete(id: string, expectedRevision: number): Promise<boolean> {
    const result = await this.executor.query(
      `DELETE FROM saas_skill_drafts
       WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND status='draft'`,
      [this.tenantId, id, expectedRevision],
    );
    return Number(result.rowCount ?? 0) > 0;
  }
}
