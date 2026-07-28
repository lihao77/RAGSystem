import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { KNOWLEDGE_APPLICATION_CAPABILITY } from "./capability.js";
import type { KnowledgePluginDependencies } from "./dependencies.js";
import { registerEmbeddingModelRoutes } from "./embedding-model-routes.js";
import { registerKnowledgeBaseRoutes } from "./routes.js";
import { createKnowledgeTools } from "./tools/KnowledgeTools.js";

export const KNOWLEDGE_PLUGIN_ID = "@ragsystem/backend-plugin-knowledge";

export function createKnowledgePlugin(dependencies: KnowledgePluginDependencies = {}): BackendPlugin {
  return {
    manifest: {
      id: KNOWLEDGE_PLUGIN_ID,
      version: "0.1.0",
    },
    register(context) {
      context.routes.register("tenant", "/api/knowledge-bases", async (app) => {
        await app.register(registerKnowledgeBaseRoutes);
      });
      context.routes.register("tenant", "/api/embedding-models", async (app) => {
        await app.register(registerEmbeddingModelRoutes);
      });
      context.tools.register(({ agent, capabilities }) => {
        if (!capabilities) throw new Error("Knowledge plugin requires runtime capabilities");
        return createKnowledgeTools({
          agent,
          knowledge: capabilities.require(KNOWLEDGE_APPLICATION_CAPABILITY),
        });
      });
    },
    start: () => dependencies.lifecycle?.start?.(),
    stop: () => dependencies.lifecycle?.stop?.(),
  };
}
