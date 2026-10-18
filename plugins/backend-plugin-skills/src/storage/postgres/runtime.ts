import { createSkillAuthoringAuthorization } from "../../authoring-authorization.js";
import path from "node:path";

import type { ObjectStorage } from "@ragsystem/backend-core/contracts/storage/object-storage.js";

import { SkillsAgentConfigService } from "../../config.js";
import type { SkillsPluginRuntimeFactory } from "../../dependencies.js";
import { SkillLibraryService } from "../../services/skill-library-service.js";
import { SkillAuthoringService } from "../../services/skill-authoring-service.js";
import { SkillToolService } from "../../tools/SkillExecution.js";
import { resolveBuiltinSkillSources } from "../../resources.js";
import { PostgresSkillsAgentConfigStore } from "./agent-config-store.js";
import type { SkillsPostgresExecutor } from "./executor.js";
import { PostgresSkillPackageRepository } from "./package-repository.js";
import { SaaSSkillPackageStore } from "./package-store.js";

export function createPostgresSkillsRuntimeFactory(options: {
  executor: SkillsPostgresExecutor;
  objects?: ObjectStorage;
}): SkillsPluginRuntimeFactory {
  return async (context) => {
    if (context.deploymentKind !== "saas") {
      throw new Error("Postgres Skills runtime factory requires a SaaS deployment");
    }
    if (!options.objects) throw new Error("SaaS Skills plugin requires object storage");
    const agentConfig = new SkillsAgentConfigService(
      new PostgresSkillsAgentConfigStore(options.executor, context.tenantId),
    );
    const cacheRoot = path.join(context.dataRoot, "skill-cache");
    const packageStore = new SaaSSkillPackageStore(
      context.tenantId,
      new PostgresSkillPackageRepository(options.executor),
      options.objects,
      cacheRoot,
    );
    const tools = new SkillToolService({
      dataRoot: context.dataRoot,
      userGlobalSkillsRoot: cacheRoot,
      skillsConfig: agentConfig,
      packageStore,
      additionalBuiltinSkillSources: resolveBuiltinSkillSources(context.resources ?? []),
    });
    const library = new SkillLibraryService(tools, packageStore);
    // Resume persisted work after a restart, including Skills that were already deleted.
    void packageStore.reclaimGarbage();
    const garbageTimer = setInterval(() => { void packageStore.reclaimGarbage(); }, 60_000);
    garbageTimer.unref();
    return {
      tools,
      agentConfig,
      library,
      authoring: new SkillAuthoringService(library),
      authorizeAuthoring: createSkillAuthoringAuthorization(context.resources, context.tenantId),
      dispose: () => clearInterval(garbageTimer),
    };
  };
}
