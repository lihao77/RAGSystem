import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { provideCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";
import {
  AGENT_CONFIG_CHANGED_EVENT,
  isAgentConfigChangedEvent,
} from "@ragsystem/backend-core/contracts/agent/agent-config-events.js";
import type { RuntimeContainerRegistry } from "@ragsystem/backend-core/services/runtime/runtime-container-registry.js";

import { AGENT_BUILDER_RUNTIME_CAPABILITY } from "./capability.js";
import { FilesystemAgentBuilderStore } from "./filesystem-store.js";
import { registerAgentBuilderRoutes } from "./routes.js";
import { AgentBuilderService } from "./service.js";
import { AGENT_BUILDER_TEAM_NAME, ensureAgentBuilderTeam } from "./team-template.js";
import { createAgentBuilderTools } from "./tools.js";
import { createAgentBuilderBindings } from "./bindings.js";
import { createAgentBuilderSystemConfigExtension } from "./config.js";

export const AGENT_BUILDER_PLUGIN_ID = "@ragsystem/backend-plugin-agent-builder";

export function createAgentBuilderPlugin(): BackendPlugin {
  let registry: RuntimeContainerRegistry | null = null;
  return {
    manifest: {
      id: AGENT_BUILDER_PLUGIN_ID,
      version: "0.1.0",
      requires: [
        "@ragsystem/backend-plugin-artifacts",
        "@ragsystem/backend-plugin-mcp",
        "@ragsystem/backend-plugin-skills",
      ],
    },
    register(context) {
      context.runtimes.register(async (runtimeContext) => {
        const unregisterSystemConfig = runtimeContext.systemConfig
          ? runtimeContext.systemConfig.registerExtension(
            AGENT_BUILDER_PLUGIN_ID,
            createAgentBuilderSystemConfigExtension(
              runtimeContext.systemConfig.getSection("agent_builder"),
              runtimeContext.systemConfig.getSection("automation"),
            ),
          )
          : () => undefined;
        try {
          await ensureAgentBuilderTeam(runtimeContext.agentConfig);
          const builder = new AgentBuilderService(
            new FilesystemAgentBuilderStore(runtimeContext.dataRoot),
            runtimeContext.agentConfig,
            runtimeContext.listPluginTools?.() ?? [],
            runtimeContext.systemConfig,
          );
          return {
            capabilities: [provideCapability(AGENT_BUILDER_RUNTIME_CAPABILITY, { service: builder })],
            dispose: unregisterSystemConfig,
          };
        } catch (error) {
          unregisterSystemConfig();
          throw error;
        }
      });
      context.applications.register((applicationContext) => {
        registry = applicationContext.registry;
        return {
          dispose() {
            registry = null;
          },
        };
      });
      context.events.on(AGENT_CONFIG_CHANGED_EVENT, async (payload) => {
        if (!registry || !isAgentConfigChangedEvent(payload)) return;
        const lease = await registry.acquire(payload.tenantId);
        try {
          const runtime = lease.runtime;
          const builder = runtime.pluginCapabilities.require(AGENT_BUILDER_RUNTIME_CAPABILITY).service;
          if (payload.change === "deleted") {
            await builder.restoreDraftAfterTeamDelete(payload.teamName);
            return;
          }
          const previousTeamName = payload.previousTeamName?.trim();
          await builder.synchronizeTeamDraft(
            payload.teamName,
            await createAgentBuilderBindings({
              agentConfig: builder.getAgentConfigService(),
              capabilities: runtime.pluginCapabilities,
              pluginTools: builder.listAvailableTools(),
            }),
            previousTeamName ? { previousTeamName } : {},
          );
        } finally {
          lease.release();
        }
      });
      context.routes.register("tenant", "/api/agent-builder", async (app) => {
        await app.register(registerAgentBuilderRoutes);
      });
      context.tools.register(({ agent, capabilities, teamName }) => {
        if (teamName !== AGENT_BUILDER_TEAM_NAME || !agent.default_entry) return [];
        if (!capabilities) throw new Error("Agent Builder plugin requires runtime capabilities");
        const enabledTools = new Set(agent.tools.enabled_tools);
        const builder = capabilities.require(AGENT_BUILDER_RUNTIME_CAPABILITY).service;
        return createAgentBuilderTools(builder, capabilities, {
          bindingsProvider: () => createAgentBuilderBindings({
            agentConfig: builder.getAgentConfigService(),
            capabilities,
            pluginTools: builder.listAvailableTools(),
          }),
        })
          .filter((tool) => enabledTools.has(tool.name));
      });
    },
  };
}
