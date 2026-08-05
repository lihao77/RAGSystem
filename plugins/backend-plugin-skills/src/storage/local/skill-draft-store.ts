import type { DatabaseSync } from "node:sqlite";

import {
  SkillDraftNameConflictError,
  isSkillDraftNameConflict,
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
        name TEXT,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        draft_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id)
      )
    `);
    // Existing local databases predate the name column; backfill and preserve
    // duplicate records under migrated names before enforcing ownership.
    const columns = db.prepare("PRAGMA table_info(skill_drafts)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "name")) {
      db.exec("ALTER TABLE skill_drafts ADD COLUMN name TEXT");
    }
    db.exec(`
      UPDATE skill_drafts
      SET name = json_extract(draft_json, '$.name')
      WHERE name IS NULL OR name = ''
    `);
    deduplicateDraftNames(db);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS skill_drafts_tenant_name_all_idx
      ON skill_drafts(tenant_id, name)
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
    try {
      this.db.prepare(`
        INSERT INTO skill_drafts(tenant_id, id, name, revision, status, draft_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.tenantId,
        parsed.id,
        parsed.name,
        parsed.revision,
        parsed.status,
        JSON.stringify(parsed),
        parsed.updated_at,
      );
    } catch (error) {
      if (isSkillDraftNameConflict(error)) throw new SkillDraftNameConflictError();
      throw error;
    }
  }

  async update(expectedRevision: number, draft: SkillDraft): Promise<boolean> {
    const parsed = SkillDraftSchema.parse(draft);
    try {
      const result = this.db.prepare(`
        UPDATE skill_drafts
        SET name = ?, revision = ?, status = ?, draft_json = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND revision = ?
      `).run(
        parsed.name,
        parsed.revision,
        parsed.status,
        JSON.stringify(parsed),
        parsed.updated_at,
        this.tenantId,
        parsed.id,
        expectedRevision,
      );
      return Number(result.changes) > 0;
    } catch (error) {
      if (isSkillDraftNameConflict(error)) throw new SkillDraftNameConflictError();
      throw error;
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare(`
      DELETE FROM skill_drafts
      WHERE tenant_id = ? AND id = ?
    `).run(this.tenantId, id);
    return Number(result.changes) > 0;
  }
}

function deduplicateDraftNames(db: DatabaseSync): void {
  const rows = db.prepare(`
    SELECT tenant_id, id, name, draft_json
    FROM skill_drafts
    ORDER BY tenant_id,
      CASE status WHEN 'published' THEN 0 ELSE 1 END,
      updated_at DESC,
      id
  `).all() as Array<{ tenant_id: string; id: string; name: string; draft_json: string }>;
  const seenByTenant = new Map<string, Set<string>>();
  const reservedByTenant = new Map<string, Set<string>>();
  for (const row of rows) {
    const reserved = reservedByTenant.get(row.tenant_id) ?? new Set<string>();
    reserved.add(row.name);
    reservedByTenant.set(row.tenant_id, reserved);
  }
  const update = db.prepare(`
    UPDATE skill_drafts
    SET name = ?, draft_json = ?
    WHERE tenant_id = ? AND id = ?
  `);
  for (const row of rows) {
    const seen = seenByTenant.get(row.tenant_id) ?? new Set<string>();
    seenByTenant.set(row.tenant_id, seen);
    if (!seen.has(row.name)) {
      seen.add(row.name);
      continue;
    }
    const parsed = SkillDraftSchema.parse(JSON.parse(row.draft_json));
    const reserved = reservedByTenant.get(row.tenant_id)!;
    const name = deduplicatedName(row.name, reserved);
    const migrated = SkillDraftSchema.parse({ ...parsed, name });
    update.run(name, JSON.stringify(migrated), row.tenant_id, row.id);
    seen.add(name);
    reserved.add(name);
  }
}

function deduplicatedName(originalName: string, reserved: Set<string>): string {
  let attempt = 1;
  while (true) {
    const suffix = String(attempt);
    const prefix = originalName.slice(0, 53 - suffix.length).replace(/-+$/, "") || "draft";
    const candidate = `${prefix}-duplicate-${suffix}`;
    if (!reserved.has(candidate)) return candidate;
    attempt += 1;
  }
}
