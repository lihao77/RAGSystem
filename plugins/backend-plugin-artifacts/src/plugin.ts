import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerArtifactRoutes } from "./routes.js";
import type { ArtifactsPluginDependencies } from "./dependencies.js";
import { createArtifactToolAfterHook } from "./artifact-hook.js";

export function createArtifactsPlugin(dependencies: ArtifactsPluginDependencies): BackendPlugin {
  return {
    manifest: {
      id: "@ragsystem/backend-plugin-artifacts",
      version: "0.1.0",
    },
    register(context) {
      context.skills.register(resolveArtifactSkillsRoot());
      context.hooks.on("tool.after", createArtifactToolAfterHook(dependencies));
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
