/** PostgreSQL schema for the SaaS memory adapter; no driver dependency. */
export interface MemoryMigration {
  version: number;
  name: string;
  sql: string;
}

export const POSTGRES_MEMORY_MIGRATIONS: readonly MemoryMigration[] = [
  {
    version: 1,
    name: "memory-entries",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('team', 'session', 'agent', 'workspace', 'user')),
        scope_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        content TEXT NOT NULL,
        why TEXT,
        how_to_apply TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        source_run_id TEXT,
        source_message_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        archived_at TIMESTAMPTZ,
        PRIMARY KEY (tenant_id, id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_entries_active_name
        ON memory_entries (tenant_id, scope, scope_id, memory_type, name)
        WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS ix_memory_entries_scope_status
        ON memory_entries (tenant_id, scope, scope_id, status, updated_at DESC);
    `,
  },
  {
    version: 2,
    name: "memory-candidates",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_candidates (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('team', 'session', 'agent', 'workspace', 'user')),
        scope_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('publish', 'archive')),
        target_memory_id TEXT,
        name TEXT,
        description TEXT,
        memory_type TEXT,
        content TEXT,
        why TEXT,
        how_to_apply TEXT,
        source_session_id TEXT,
        source_run_id TEXT,
        source_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'candidate'
          CHECK (status IN ('candidate', 'approved', 'rejected', 'withdrawn')),
        reviewer_user_id TEXT,
        review_comment TEXT,
        published_memory_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reviewed_at TIMESTAMPTZ,
        PRIMARY KEY (tenant_id, id),
        FOREIGN KEY (tenant_id, target_memory_id) REFERENCES memory_entries (tenant_id, id),
        FOREIGN KEY (tenant_id, published_memory_id) REFERENCES memory_entries (tenant_id, id)
      );
      CREATE INDEX IF NOT EXISTS ix_memory_candidates_owner_status
        ON memory_candidates (tenant_id, owner_user_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS ix_memory_candidates_scope_status
        ON memory_candidates (tenant_id, scope, scope_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS memory_scope_revisions (
        tenant_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('team', 'session', 'agent', 'workspace', 'user')),
        scope_id TEXT NOT NULL,
        revision BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, scope, scope_id)
      );
    `,
  },
  {
    version: 3,
    name: "memory-candidate-review-claims",
    sql: `
      ALTER TABLE memory_candidates
        ADD COLUMN IF NOT EXISTS review_claim_token TEXT,
        ADD COLUMN IF NOT EXISTS review_claimed_at TIMESTAMPTZ;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_candidates_review_claim_token
        ON memory_candidates (tenant_id, review_claim_token)
        WHERE review_claim_token IS NOT NULL;
      CREATE INDEX IF NOT EXISTS ix_memory_candidates_review_claim
        ON memory_candidates (tenant_id, status, review_claimed_at)
        WHERE status = 'candidate';
    `,
  },
  {
    version: 4,
    name: "publish-existing-personal-memory-candidates",
    sql: `
      WITH promoted AS (
        INSERT INTO memory_entries (
          id, tenant_id, scope, scope_id, name, description, memory_type, content,
          why, how_to_apply, source_run_id, source_message_id, created_at, updated_at
        )
        SELECT
          id, tenant_id, scope, scope_id, name, description, memory_type, content,
          why, how_to_apply, source_run_id, source_message_id, created_at, updated_at
        FROM memory_candidates
        WHERE status = 'candidate'
          AND operation = 'publish'
          AND scope IN ('session', 'user', 'workspace')
        ON CONFLICT DO NOTHING
        RETURNING tenant_id, scope, scope_id
      ),
      revision_increments AS (
        SELECT tenant_id, scope, scope_id, COUNT(*)::BIGINT AS increment
        FROM promoted
        GROUP BY tenant_id, scope, scope_id
      )
      INSERT INTO memory_scope_revisions (tenant_id, scope, scope_id, revision)
      SELECT tenant_id, scope, scope_id, increment
      FROM revision_increments
      ON CONFLICT (tenant_id, scope, scope_id)
      DO UPDATE SET
        revision = memory_scope_revisions.revision + EXCLUDED.revision,
        updated_at = CURRENT_TIMESTAMP;

      UPDATE memory_candidates AS candidate
      SET
        status = 'approved',
        reviewer_user_id = candidate.owner_user_id,
        review_comment = 'personal scope auto-published by migration',
        published_memory_id = candidate.id,
        version = candidate.version + 1,
        reviewed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE candidate.status = 'candidate'
        AND candidate.operation = 'publish'
        AND candidate.scope IN ('session', 'user', 'workspace')
        AND EXISTS (
          SELECT 1
          FROM memory_entries AS entry
          WHERE entry.tenant_id = candidate.tenant_id
            AND entry.id = candidate.id
        );
    `,
  },
  {
    version: 5,
    name: "memory-agent-configs",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_agent_configs (
        tenant_id TEXT NOT NULL,
        team_name TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        config JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, team_name, agent_name)
      );
    `,
  },
];

export const SAAS_MEMORY_MIGRATIONS = POSTGRES_MEMORY_MIGRATIONS;
export const POSTGRES_MEMORY_LATEST_SCHEMA_VERSION = POSTGRES_MEMORY_MIGRATIONS.length;

export function getPendingPostgresMemoryMigrations(appliedVersion: number): readonly MemoryMigration[] {
  if (!Number.isInteger(appliedVersion) || appliedVersion < 0 || appliedVersion > POSTGRES_MEMORY_LATEST_SCHEMA_VERSION) {
    throw new Error(`invalid PostgreSQL memory schema version: ${appliedVersion}`);
  }
  return POSTGRES_MEMORY_MIGRATIONS.filter((migration) => migration.version > appliedVersion);
}

export function getPostgresMemoryMigrationSql(): string {
  return POSTGRES_MEMORY_MIGRATIONS.map((migration) => migration.sql).join("\n");
}

export function getSaasMemoryMigrations(): readonly MemoryMigration[] {
  return POSTGRES_MEMORY_MIGRATIONS.map((migration) => ({ ...migration }));
}
