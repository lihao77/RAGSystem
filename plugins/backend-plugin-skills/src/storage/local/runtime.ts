import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { SkillsAgentConfigService } from "../../config.js";
import type { SkillsPluginRuntimeFactory } from "../../dependencies.js";
import { SkillLibraryService } from "../../services/skill-library-service.js";
import { SkillToolService } from "../../tools/SkillExecution.js";
import { resolveArtifactStagingService, resolveBuiltinSkillSources } from "../../resources.js";
import { SqliteSkillsAgentConfigStore } from "./agent-config-store.js";
import { FilesystemSkillPackageStore } from "./package-store.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export function createLocalSkillsRuntimeFactory(): SkillsPluginRuntimeFactory {
  return (context) => {
    if (context.deploymentKind !== "local") {
      throw new Error("Local Skills runtime factory requires a Local deployment");
    }
    const dbPath = path.join(context.dataRoot, "db", "skills.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    const agentConfig = new SkillsAgentConfigService(
      new SqliteSkillsAgentConfigStore(db, context.tenantId),
    );
    const packageRoot = path.join(context.dataRoot, "skills");
    const packageStore = new FilesystemSkillPackageStore(packageRoot);
    const tools = new SkillToolService({
      dataRoot: context.dataRoot,
      userGlobalSkillsRoot: packageRoot,
      skillsConfig: agentConfig,
      backgroundTasks: context.backgroundTasks,
      clientEvents: context.clientEvents,
      packageStore,
      additionalBuiltinSkillSources: resolveBuiltinSkillSources(context.resources ?? []),
      artifactStaging: resolveArtifactStagingService(
        context.resources ?? [],
        context.tenantId,
        context.dataRoot,
      ),
    });
    return {
      tools,
      agentConfig,
      library: new SkillLibraryService(tools, packageStore),
      dispose: () => db.close(),
    };
  };
}
