import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerArtifactRoutes } from "./routes.js";
import {
  ARTIFACT_APPLICATION_RESOURCE_KIND,
  type ArtifactsPluginDependencies,
} from "./dependencies.js";
import { createArtifactToolAfterHook } from "./artifact-hook.js";
import { ARTIFACT_STAGING_RESOURCE_KIND } from "./staging/contracts.js";
import { createFilesystemArtifactStagingProvider } from "./staging/filesystem-staging-provider.js";

const SKILL_SOURCE_RESOURCE_KIND = "ragsystem.skill-source";
export const ARTIFACTS_PLUGIN_ID = "@ragsystem/backend-plugin-artifacts";

export function createArtifactsPlugin(dependencies: ArtifactsPluginDependencies): BackendPlugin {
  const staging = dependencies.staging ?? createFilesystemArtifactStagingProvider();
  return {
    manifest: {
      id: ARTIFACTS_PLUGIN_ID,
      version: "0.1.0",
    },
    register(context) {
      context.resources.register(
        ARTIFACT_APPLICATION_RESOURCE_KIND,
        {
          applicationForTenant: (tenantId: string) => dependencies.storage.applicationForTenant(tenantId),
          assertReadable: (request: FastifyRequest, sessionId: string) => dependencies.sessionAccess.assertReadable(request, sessionId),
        },
      );
      context.resources.register(SKILL_SOURCE_RESOURCE_KIND, resolveArtifactSkillsRoot());
      context.resources.register(ARTIFACT_STAGING_RESOURCE_KIND, staging);
      context.hooks.on("tool.after", createArtifactToolAfterHook({ ...dependencies, staging }));
      context.routes.register("tenant", "/api/artifacts", async (app) => {
        await app.register(registerArtifactRoutes, dependencies);
      });
    },
    start: () => dependencies.storage.start?.(),
    stop: () => dependencies.storage.stop?.(),
  };
}

function resolveArtifactSkillsRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../skills"),
    path.resolve(moduleDir, "plugin-assets/artifacts/skills"),
  ];
  const root = candidates.find((candidate) => fs.existsSync(path.join(candidate, "visualization", "SKILL.md")));
  if (!root) throw new Error(`Artifact plugin skills are missing; checked: ${candidates.join(", ")}`);
  return root;
}
