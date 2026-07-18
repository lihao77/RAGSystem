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
