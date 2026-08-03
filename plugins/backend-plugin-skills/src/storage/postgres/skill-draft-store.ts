import type { TenantId } from "@ragsystem/backend-core/identity/types.js";

import {
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
      `INSERT INTO saas_skill_drafts(tenant_id, id, revision, status, draft, updated_at)
       VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        this.tenantId,
        parsed.id,
        parsed.revision,
        parsed.status,
        JSON.stringify(parsed),
        parsed.updated_at,
      ],
    );
  }

  async update(expectedRevision: number, draft: SkillDraft): Promise<boolean> {
    const parsed = SkillDraftSchema.parse(draft);
    const result = await this.executor.query(
      `UPDATE saas_skill_drafts
       SET revision=$1, status=$2, draft=$3::jsonb, updated_at=$4
       WHERE tenant_id=$5 AND id=$6 AND revision=$7`,
      [
        parsed.revision,
        parsed.status,
        JSON.stringify(parsed),
        parsed.updated_at,
        this.tenantId,
        parsed.id,
        expectedRevision,
      ],
    );
    return Number(result.rowCount ?? 0) > 0;
  }
}
