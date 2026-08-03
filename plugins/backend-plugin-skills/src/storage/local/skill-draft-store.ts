import type { DatabaseSync } from "node:sqlite";

import {
  SkillDraftSchema,
  type SkillDraft,
  type SkillDraftStore,
} from "../../contracts/skills/skill-draft.js";

export class SqliteSkillDraftStore implements SkillDraftStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tenantId: string,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_drafts (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        draft_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id)
      )
    `);
  }

  async list(): Promise<SkillDraft[]> {
    const rows = this.db.prepare(
      "SELECT draft_json FROM skill_drafts WHERE tenant_id = ? ORDER BY updated_at DESC",
    ).all(this.tenantId) as Array<{ draft_json: string }>;
    return rows.map((row) => SkillDraftSchema.parse(JSON.parse(row.draft_json)));
  }

  async get(id: string): Promise<SkillDraft | null> {
    const row = this.db.prepare(
      "SELECT draft_json FROM skill_drafts WHERE tenant_id = ? AND id = ?",
    ).get(this.tenantId, id) as { draft_json: string } | undefined;
    return row ? SkillDraftSchema.parse(JSON.parse(row.draft_json)) : null;
  }

  async create(draft: SkillDraft): Promise<void> {
    const parsed = SkillDraftSchema.parse(draft);
    this.db.prepare(`
      INSERT INTO skill_drafts(tenant_id, id, revision, status, draft_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      this.tenantId,
      parsed.id,
      parsed.revision,
      parsed.status,
      JSON.stringify(parsed),
      parsed.updated_at,
    );
  }

  async update(expectedRevision: number, draft: SkillDraft): Promise<boolean> {
    const parsed = SkillDraftSchema.parse(draft);
    const result = this.db.prepare(`
      UPDATE skill_drafts
      SET revision = ?, status = ?, draft_json = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ? AND revision = ?
    `).run(
      parsed.revision,
      parsed.status,
      JSON.stringify(parsed),
      parsed.updated_at,
      this.tenantId,
      parsed.id,
      expectedRevision,
    );
    return Number(result.changes) > 0;
  }
}
