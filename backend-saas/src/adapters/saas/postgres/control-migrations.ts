import type { Pool, PoolClient } from "pg";

const CONTROL_MIGRATION_ADVISORY_LOCK_ID = 0x52414743;

export interface PostgresControlMigration {
  readonly version: number;
  readonly name: string;
  readonly legacyNames?: readonly string[];
  readonly sql: string;
}

export const POSTGRES_CONTROL_MIGRATIONS: readonly PostgresControlMigration[] = [
  {
    version: 1,
    name: "control-plane-core",
    sql: `
      CREATE TABLE control_tenants (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'))
      );

      CREATE TABLE control_users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        username TEXT UNIQUE,
        password_hash TEXT,
        platform_role TEXT CHECK (platform_role IS NULL OR platform_role = 'admin'),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        type TEXT NOT NULL DEFAULT 'human' CHECK (type IN ('human', 'bot')),
        owner_id TEXT REFERENCES control_users(id) ON DELETE CASCADE
      );

      CREATE INDEX control_users_status_idx ON control_users(status);
      CREATE INDEX control_users_platform_role_idx ON control_users(platform_role);
      CREATE INDEX control_users_owner_id_idx ON control_users(owner_id);

      CREATE TABLE control_memberships (
        user_id TEXT NOT NULL REFERENCES control_users(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES control_tenants(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        PRIMARY KEY (user_id, tenant_id)
      );

      CREATE INDEX control_memberships_tenant_id_idx ON control_memberships(tenant_id);

      CREATE TABLE control_user_sessions (
        jti TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES control_users(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES control_tenants(id) ON DELETE CASCADE,
        issued_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        revoked BOOLEAN NOT NULL DEFAULT FALSE
      );

      CREATE INDEX control_user_sessions_user_id_idx ON control_user_sessions(user_id);
      CREATE INDEX control_user_sessions_tenant_id_idx ON control_user_sessions(tenant_id);
      CREATE INDEX control_user_sessions_expires_at_idx ON control_user_sessions(expires_at);

      CREATE TABLE control_system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE control_platform_audit (
        id BIGSERIAL PRIMARY KEY,
        actor_user_id TEXT NOT NULL REFERENCES control_users(id) ON DELETE RESTRICT,
        action TEXT NOT NULL,
        target_tenant_id TEXT REFERENCES control_tenants(id) ON DELETE SET NULL,
        target_resource TEXT NOT NULL,
        detail_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX control_platform_audit_created_at_idx
        ON control_platform_audit(created_at DESC, id DESC);
    `,
  },
  {
    version: 2,
    name: "bot-and-secret-storage",
    legacyNames: ["bot-widget-and-secret-storage"],
    sql: `
      CREATE TABLE control_secret_envelopes (
        tenant_id TEXT NOT NULL REFERENCES control_tenants(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (length(purpose) > 0),
        resource_id TEXT NOT NULL CHECK (length(resource_id) > 0),
        field TEXT NOT NULL CHECK (length(field) > 0),
        envelope_version INTEGER NOT NULL DEFAULT 1 CHECK (envelope_version > 0),
        nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
        auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
        ciphertext BYTEA NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, purpose, resource_id, field)
      );

      CREATE INDEX control_secret_envelopes_resource_idx
        ON control_secret_envelopes(tenant_id, purpose, resource_id);

    `,
  },
  {
    version: 3,
    name: "control-cron-lease",
    sql: "SELECT 1;",
  },
  {
    version: 4,
    name: "control-bot-team",
    sql: "SELECT 1;",
  },
];

export const POSTGRES_CONTROL_LATEST_SCHEMA_VERSION = POSTGRES_CONTROL_MIGRATIONS.length;

export interface PostgresControlMigrationResult {
  previous_version: number;
  current_version: number;
  applied_versions: number[];
}

export async function runPostgresControlMigrations(pool: Pool): Promise<PostgresControlMigrationResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [CONTROL_MIGRATION_ADVISORY_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ragsystem_control_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const applied = await client.query<{ version: number | string; name: string }>(
      "SELECT version, name FROM ragsystem_control_schema_migrations ORDER BY version ASC",
    );
    validateMigrationHistory(applied.rows);
    const previousVersion = applied.rows.length;
    const pending = POSTGRES_CONTROL_MIGRATIONS.slice(previousVersion);
    for (const migration of pending) {
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO ragsystem_control_schema_migrations(version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
    }
    await client.query("COMMIT");
    return {
      previous_version: previousVersion,
      current_version: POSTGRES_CONTROL_LATEST_SCHEMA_VERSION,
      applied_versions: pending.map((migration) => migration.version),
    };
  } catch (error) {
    await rollback(client, error);
    throw error;
  } finally {
    client.release();
  }
}

function validateMigrationHistory(rows: ReadonlyArray<{ version: number | string; name: string }>): void {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expected = POSTGRES_CONTROL_MIGRATIONS[index];
    const nameMatches = expected && (row?.name === expected.name || expected.legacyNames?.includes(row?.name ?? ""));
    if (!row || !expected || Number(row.version) !== expected.version || !nameMatches) {
      throw new Error(`invalid PostgreSQL control migration history at version ${String(row?.version ?? index + 1)}`);
    }
  }
}

async function rollback(client: PoolClient, error: unknown): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    if (error instanceof Error) error.cause ??= rollbackError;
  }
}
