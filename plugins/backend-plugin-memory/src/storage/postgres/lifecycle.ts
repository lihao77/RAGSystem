import type { MemoryPluginLifecycle } from "../../dependencies.js";
import { runPostgresMemoryMigrations } from "./migrations.js";
import type { PostgresMemoryExecutor } from "./repository.js";

export function createPostgresMemoryLifecycle(executor: PostgresMemoryExecutor): MemoryPluginLifecycle {
  return {
    start: () => runPostgresMemoryMigrations(executor).then(() => undefined),
  };
}
