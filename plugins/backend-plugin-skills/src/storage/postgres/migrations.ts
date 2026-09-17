import type { SkillsPostgresExecutor } from "./executor.js";
import { POSTGRES_SKILLS_MIGRATIONS } from "./schema.js";
import { normalizeSkillObjectGarbageSchema } from "./object-garbage-hydration.js";

export async function runPostgresSkillPackageMigrations(
  executor: SkillsPostgresExecutor,
): Promise<{ current_version: number; applied_versions: number[] }> {
  return executor.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(701884216)");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS ragsystem_skill_package_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    const applied = await tx.query<{ version: number | string; name: string }>(
      "SELECT version,name FROM ragsystem_skill_package_schema_migrations ORDER BY version",
    );
    // Retired draft-era migrations (v3 skill_drafts / v4 skill_draft_names): their history
    // rows and tables must be struck before the prefix check below, or any database that
    // once ran them fails to start. Shape-guarded by (version, name) so a future re-use of
    // these version numbers is untouched, and idempotent for fresh and half-migrated states.
    await tx.query("DROP TABLE IF EXISTS saas_skill_drafts");
    await tx.query(
      "DELETE FROM ragsystem_skill_package_schema_migrations WHERE (version,name) IN ((3,'skill_drafts'),(4,'skill_draft_names'))",
    );
    const retired = (row: { version: number | string; name: string }) =>
      (Number(row.version) === 3 && row.name === "skill_drafts")
      || (Number(row.version) === 4 && row.name === "skill_draft_names");
    const active = applied.rows.filter((row) => !retired(row));
    for (let i = 0; i < active.length; i += 1) {
      const expected = POSTGRES_SKILLS_MIGRATIONS[i];
      if (
        !expected
        || Number(active[i]?.version) !== expected.version
        || active[i]?.name !== expected.name
      ) {
        throw new Error("invalid PostgreSQL skill package migration history");
      }
    }
    const pending = POSTGRES_SKILLS_MIGRATIONS.slice(active.length);
    for (const migration of pending) {
      await tx.query(migration.sql);
      await tx.query(
        "INSERT INTO ragsystem_skill_package_schema_migrations(version,name) VALUES($1,$2)",
        [migration.version, migration.name],
      );
    }
    await normalizeSkillObjectGarbageSchema(tx);
    return {
      current_version: POSTGRES_SKILLS_MIGRATIONS.at(-1)?.version ?? 0,
      applied_versions: pending.map((migration) => migration.version),
    };
  });
}
