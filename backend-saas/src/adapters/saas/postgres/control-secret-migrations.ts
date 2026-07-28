import type { Pool } from "pg";
import { POSTGRES_CONTROL_MIGRATIONS, runPostgresControlMigrations } from "./control-migrations.js";

export interface PostgresSecretMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const POSTGRES_SECRET_MIGRATIONS: readonly PostgresSecretMigration[] = [
  {
    version: 1,
    name: "control-v2-secret-envelopes",
    sql: POSTGRES_CONTROL_MIGRATIONS[1]?.sql ?? "",
  },
];

export const POSTGRES_SECRET_LATEST_SCHEMA_VERSION = POSTGRES_SECRET_MIGRATIONS.length;

export interface PostgresSecretMigrationResult {
  previous_version: number;
  current_version: number;
  applied_versions: number[];
}

export async function runPostgresSecretMigrations(pool: Pool): Promise<PostgresSecretMigrationResult> {
  // Secret envelopes are part of Control v2. Keep this compatibility entry
  // point so callers cannot accidentally create a second migration history.
  const result = await runPostgresControlMigrations(pool);
  return {
    previous_version: Math.max(0, result.previous_version - 1),
    current_version: POSTGRES_SECRET_LATEST_SCHEMA_VERSION,
    applied_versions: result.applied_versions.includes(2) ? [1] : [],
  };
}
