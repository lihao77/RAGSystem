import type { SkillsPluginLifecycle } from "../../dependencies.js";
import type { SkillsPostgresExecutor } from "./executor.js";
import { runPostgresSkillPackageMigrations } from "./migrations.js";

export function createPostgresSkillsLifecycle(executor: SkillsPostgresExecutor): SkillsPluginLifecycle {
  return {
    start: () => runPostgresSkillPackageMigrations(executor).then(() => undefined),
  };
}
