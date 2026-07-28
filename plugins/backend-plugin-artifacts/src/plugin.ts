import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { registerArtifactRoutes } from "./routes.js";
import type { ArtifactsPluginDependencies } from "./dependencies.js";

export function createArtifactsPlugin(dependencies: ArtifactsPluginDependencies): BackendPlugin {
  return {
    manifest: {
      id: "@ragsystem/backend-plugin-artifacts",
      version: "0.1.0",
    },
    register(context) {
      context.routes.register("tenant", "/api/artifacts", async (app) => {
        await app.register(registerArtifactRoutes, dependencies);
      });
    },
  };
}
