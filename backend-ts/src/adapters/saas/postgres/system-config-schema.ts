export interface PostgresSystemConfigMigration {
  version: number;
  name: string;
  sql: string;
}

export const POSTGRES_SYSTEM_CONFIG_MIGRATIONS: PostgresSystemConfigMigration[] = [
  {
    version: 1,
    name: "system_config_document",
    sql: `
      CREATE TABLE IF NOT EXISTS saas_system_configs (
        tenant_id TEXT PRIMARY KEY,
        config JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
];
