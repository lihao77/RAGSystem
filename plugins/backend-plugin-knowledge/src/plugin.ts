import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { provideCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";

import { KNOWLEDGE_RUNTIME_CAPABILITY } from "./capability.js";
import type { KnowledgePluginDependencies } from "./dependencies.js";
import { registerEmbeddingModelRoutes } from "./embedding-model-routes.js";
import { registerKnowledgeBaseRoutes } from "./routes.js";
import { createKnowledgeSystemConfigExtension } from "./system-config.js";
import { createKnowledgeTools } from "./tools/KnowledgeTools.js";

export const KNOWLEDGE_PLUGIN_ID = "@ragsystem/backend-plugin-knowledge";

export function createKnowledgePlugin(dependencies: KnowledgePluginDependencies): BackendPlugin {
  return {
    manifest: {
      id: KNOWLEDGE_PLUGIN_ID,
      version: "0.1.0",
    },
    register(context) {
      context.runtimes.register(async (runtimeContext) => {
        const unregisterSystemConfig = runtimeContext.systemConfig.registerExtension(
          KNOWLEDGE_PLUGIN_ID,
          createKnowledgeSystemConfigExtension(
            runtimeContext.systemConfig.getSection("document_extraction"),
          ),
        );
        try {
          const runtime = await dependencies.runtimeFactory(runtimeContext);
          return {
            capabilities: [provideCapability(KNOWLEDGE_RUNTIME_CAPABILITY, runtime)],
            dispose: () => {
              try {
                runtime.dispose?.();
              } finally {
                unregisterSystemConfig();
              }
            },
          };
        } catch (error) {
          unregisterSystemConfig();
          throw error;
        }
      });
      context.routes.register("tenant", "/api/knowledge-bases", async (app) => {
        await app.register(registerKnowledgeBaseRoutes);
      });
      context.routes.register("tenant", "/api/embedding-models", async (app) => {
        await app.register(registerEmbeddingModelRoutes);
      });
      context.tools.register(async ({ agent, teamName, capabilities }) => {
        if (!capabilities) throw new Error("Knowledge plugin requires runtime capabilities");
        const runtime = capabilities.require(KNOWLEDGE_RUNTIME_CAPABILITY);
        const config = await runtime.agentConfig.getEffective({
          teamName: teamName ?? "default",
          agentName: agent.agent_name,
        });
        return createKnowledgeTools({
          config,
          knowledge: runtime.application,
        });
      });
    },
    start: () => dependencies.lifecycle?.start?.(),
    stop: () => dependencies.lifecycle?.stop?.(),
  };
}
