import type { Pool, PoolClient } from "pg";

const CONTROL_MIGRATION_ADVISORY_LOCK_ID = 0x52414743;

export interface PostgresControlMigration {
  readonly version: number;
  readonly name: string;
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
    name: "bot-widget-and-secret-storage",
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

      CREATE TABLE control_bot_configs (
        bot_id TEXT PRIMARY KEY REFERENCES control_users(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES control_tenants(id) ON DELETE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        entry_agent TEXT,
        session_id TEXT,
        default_session_ttl INTEGER NOT NULL DEFAULT 86400 CHECK (default_session_ttl > 0),
        permission_mode TEXT NOT NULL DEFAULT 'relaxed',
        feishu_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        feishu_app_id TEXT,
        feishu_receive_mode TEXT NOT NULL DEFAULT 'webhook' CHECK (feishu_receive_mode IN ('webhook', 'long_connection')),
        route_token_digest TEXT,
        feishu_default_chat_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (tenant_id, bot_id)
      );

      CREATE INDEX control_bot_configs_tenant_idx ON control_bot_configs(tenant_id);
      CREATE INDEX control_bot_configs_enabled_idx ON control_bot_configs(enabled, feishu_enabled);
      CREATE UNIQUE INDEX control_bot_configs_route_digest_idx
        ON control_bot_configs(route_token_digest)
        WHERE route_token_digest IS NOT NULL;

      CREATE TABLE control_bot_cron_tasks (
        bot_id TEXT NOT NULL REFERENCES control_bot_configs(bot_id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        cron TEXT NOT NULL,
        task TEXT NOT NULL,
        entry_agent TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        push_platform TEXT CHECK (push_platform IS NULL OR push_platform = 'feishu'),
        push_chat_id TEXT,
        next_run DOUBLE PRECISION,
        last_run DOUBLE PRECISION,
        last_result TEXT,
        PRIMARY KEY (bot_id, task_id)
      );

      CREATE INDEX control_bot_cron_due_idx
        ON control_bot_cron_tasks(enabled, next_run);

      CREATE TABLE control_widget_apps (
        app_key TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES control_tenants(id) ON DELETE CASCADE,
        secret_hash TEXT NOT NULL,
        secret_prefix TEXT NOT NULL,
        display_name TEXT NOT NULL,
        allowed_origins TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TIMESTAMPTZ
      );

      CREATE INDEX control_widget_apps_tenant_idx ON control_widget_apps(tenant_id);

      CREATE TABLE control_widget_tokens (
        jti TEXT PRIMARY KEY,
        app_key TEXT NOT NULL REFERENCES control_widget_apps(app_key) ON DELETE CASCADE,
        issued_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        revoked BOOLEAN NOT NULL DEFAULT FALSE
      );

      CREATE INDEX control_widget_tokens_app_idx ON control_widget_tokens(app_key, issued_at DESC);
      CREATE INDEX control_widget_tokens_expiry_idx ON control_widget_tokens(expires_at);

      CREATE TABLE control_widget_audit (
        id BIGSERIAL PRIMARY KEY,
        app_key TEXT NOT NULL REFERENCES control_widget_apps(app_key) ON DELETE CASCADE,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX control_widget_audit_app_idx ON control_widget_audit(app_key, id DESC);

    `,
  },
  {
    version: 3,
    name: "control-cron-lease",
    sql: `
      ALTER TABLE control_bot_cron_tasks
        ADD COLUMN lease_owner TEXT,
        ADD COLUMN lease_token TEXT,
        ADD COLUMN lease_expires_at DOUBLE PRECISION,
        ADD COLUMN last_attempt_id TEXT,
        ADD COLUMN attempt_count BIGINT NOT NULL DEFAULT 0;

      CREATE UNIQUE INDEX control_bot_cron_attempt_idx
        ON control_bot_cron_tasks(last_attempt_id)
        WHERE last_attempt_id IS NOT NULL;

      CREATE INDEX control_bot_cron_claimable_idx
        ON control_bot_cron_tasks(enabled, next_run, lease_expires_at);
    `,
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
    if (!row || !expected || Number(row.version) !== expected.version || row.name !== expected.name) {
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
