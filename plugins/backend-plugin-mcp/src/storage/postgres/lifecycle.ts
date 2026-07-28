import type { McpPluginLifecycle } from "../../dependencies.js";
import { runPostgresMcpMigrations } from "./migrations.js";
import type { PostgresMcpExecutor } from "./repository.js";

export function createPostgresMcpLifecycle(executor: PostgresMcpExecutor): McpPluginLifecycle {
  return { start: () => runPostgresMcpMigrations(executor).then(() => undefined) };
}
