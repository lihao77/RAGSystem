import type { KnowledgePluginLifecycle } from "../../dependencies.js";
import type { KnowledgePostgresExecutor } from "./executor.js";
import { runPostgresKnowledgeConfigMigrations } from "./knowledge-config-migrations.js";
import { runPostgresKnowledgeFileMigrations } from "./knowledge-file-migrations.js";
import { runPostgresPgVectorMigrations } from "./pgvector-migrations.js";
import { runPostgresVectorIndexMigrations } from "./vector-index-migrations.js";

export function createPostgresKnowledgeLifecycle(
  executor: KnowledgePostgresExecutor,
): KnowledgePluginLifecycle {
  return {
    async start() {
      await runPostgresKnowledgeFileMigrations(executor);
      await runPostgresKnowledgeConfigMigrations(executor);
      await runPostgresVectorIndexMigrations(executor);
      await runPostgresPgVectorMigrations(executor);
    },
  };
}
