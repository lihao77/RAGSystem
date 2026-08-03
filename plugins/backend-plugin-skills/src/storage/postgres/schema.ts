export interface PostgresSkillPackageMigration {
  version: number;
  name: string;
  sql: string;
}

export const POSTGRES_SKILLS_MIGRATIONS: PostgresSkillPackageMigration[] = [
  {
    version: 1,
    name: "tenant_skill_packages",
    sql: `
      CREATE TABLE IF NOT EXISTS saas_skill_packages (
        tenant_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        content_hash TEXT NOT NULL,
        package_prefix TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, skill_name)
      );
      CREATE TABLE IF NOT EXISTS saas_skill_package_files (
        tenant_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        object_key TEXT NOT NULL,
        content_type TEXT,
        size_bytes BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, skill_name, relative_path),
        FOREIGN KEY (tenant_id, skill_name)
          REFERENCES saas_skill_packages(tenant_id, skill_name)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS saas_skill_packages_tenant_idx ON saas_skill_packages(tenant_id);
    `,
  },
  {
    version: 2,
    name: "agent_configs",
    sql: `
      CREATE TABLE IF NOT EXISTS skill_agent_configs (
        tenant_id TEXT NOT NULL,
        team_name TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        config JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, team_name, agent_name)
      );
    `,
  },
  {
    version: 3,
    name: "skill_drafts",
    sql: `
      CREATE TABLE IF NOT EXISTS saas_skill_drafts (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        draft JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, id)
      );
      CREATE INDEX IF NOT EXISTS saas_skill_drafts_tenant_updated_idx
      ON saas_skill_drafts(tenant_id, updated_at DESC);
    `,
  },
  {
    version: 4,
    name: "skill_draft_names",
    sql: `
      ALTER TABLE saas_skill_drafts ADD COLUMN IF NOT EXISTS name TEXT;
      UPDATE saas_skill_drafts
      SET name = draft->>'name'
      WHERE name IS NULL OR name = '';
      DO $skill_draft_names$
      DECLARE
        duplicate_row RECORD;
        attempt INTEGER;
        suffix TEXT;
        candidate TEXT;
      BEGIN
        FOR duplicate_row IN
          SELECT tenant_id, id, name
          FROM (
            SELECT tenant_id, id, name,
              ROW_NUMBER() OVER (
                PARTITION BY tenant_id, name
                ORDER BY CASE status WHEN 'published' THEN 0 ELSE 1 END, updated_at DESC, id
              ) AS duplicate_number
            FROM saas_skill_drafts
          ) AS ranked
          WHERE duplicate_number > 1
          ORDER BY tenant_id, id
        LOOP
          attempt := 1;
          LOOP
            suffix := attempt::TEXT;
            candidate := RTRIM(LEFT(duplicate_row.name, 53 - LENGTH(suffix)), '-')
              || '-duplicate-' || suffix;
            EXIT WHEN NOT EXISTS (
              SELECT 1
              FROM saas_skill_drafts
              WHERE tenant_id = duplicate_row.tenant_id AND name = candidate
            );
            attempt := attempt + 1;
          END LOOP;
          UPDATE saas_skill_drafts
          SET name = candidate,
              draft = jsonb_set(draft, '{name}', to_jsonb(candidate), true)
          WHERE tenant_id = duplicate_row.tenant_id AND id = duplicate_row.id;
        END LOOP;
      END;
      $skill_draft_names$;
      ALTER TABLE saas_skill_drafts ALTER COLUMN name SET NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS saas_skill_drafts_tenant_name_idx
        ON saas_skill_drafts(tenant_id, name);
    `,
  },
];
