import type { PostgresExecutor } from "./postgres-executor.js";
import { POSTGRES_WS_TICKET_MIGRATIONS } from "./ws-ticket-schema.js";

export async function runPostgresWsTicketMigrations(executor: PostgresExecutor): Promise<void> {
  await executor.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [0x52414757]);
    await tx.query("CREATE TABLE IF NOT EXISTS ragsystem_ws_ticket_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    const applied = await tx.query<{ version: number | string; name: string }>("SELECT version,name FROM ragsystem_ws_ticket_schema_migrations ORDER BY version");
    for (let index = 0; index < applied.rows.length; index += 1) {
      const expected = POSTGRES_WS_TICKET_MIGRATIONS[index];
      const row = applied.rows[index];
      if (!expected || !row || Number(row.version) !== expected.version || row.name !== expected.name) {
        throw new Error("invalid PostgreSQL websocket-ticket migration history");
      }
    }
    for (const migration of POSTGRES_WS_TICKET_MIGRATIONS.slice(applied.rows.length)) {
      await tx.query(migration.sql);
      await tx.query("INSERT INTO ragsystem_ws_ticket_schema_migrations(version,name) VALUES($1,$2)", [migration.version, migration.name]);
    }
  });
}
