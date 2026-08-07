import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { provideCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";

import { SKILLS_RUNTIME_CAPABILITY } from "./capability.js";
import type { SkillsPluginDependencies } from "./dependencies.js";
import { registerSkillRoutes } from "./routes.js";
import { createSkillTools } from "./tools/SkillTools.js";
import { createSkillAuthoringTools } from "./tools/SkillAuthoringTools.js";
import { createSkillsSystemConfigExtension } from "./system-config.js";

export const SKILLS_PLUGIN_ID = "@ragsystem/backend-plugin-skills";

export function createSkillsPlugin(dependencies: SkillsPluginDependencies): BackendPlugin {
  return {
    manifest: { id: SKILLS_PLUGIN_ID, version: "0.1.0" },
    register(context) {
      context.runtimes.register(async (runtimeContext) => {
        const unregisterSystemConfig = runtimeContext.systemConfig
          ? runtimeContext.systemConfig.registerExtension(
            SKILLS_PLUGIN_ID,
            createSkillsSystemConfigExtension(
              runtimeContext.systemConfig.getSection("skills"),
            ),
          )
          : () => undefined;
        try {
          const runtime = await dependencies.runtimeFactory(runtimeContext);
          return {
            capabilities: [provideCapability(SKILLS_RUNTIME_CAPABILITY, runtime)],
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
      context.routes.register("tenant", "/api/skills", async (app, routeContext) => {
        await app.register(
          registerSkillRoutes,
          routeContext.emitPluginEvent ? { emitPluginEvent: routeContext.emitPluginEvent } : {},
        );
      });
      context.tools.register(async ({ agent, teamName, capabilities, pathAccessPolicy }) => {
        if (!capabilities) throw new Error("Skills plugin requires runtime capabilities");
        const runtime = capabilities.require(SKILLS_RUNTIME_CAPABILITY);
        await runtime.tools.hydrateUserGlobalPackages();
        const config = await runtime.agentConfig.getEffective({
          teamName: teamName ?? "default",
          agentName: agent.agent_name,
        });
        const usageTools = createSkillTools({
          skillTools: runtime.tools,
          agent,
          config,
          pathService: pathAccessPolicy,
        });
        const enabledTools = new Set(agent.tools.enabled_tools);
        const authoringTools = teamName === "agent-builder" && agent.default_entry
          ? createSkillAuthoringTools({
            authoring: runtime.authoring,
            agentName: agent.agent_name,
          }).filter((tool) => enabledTools.has(tool.name))
          : [];
        return [
          ...usageTools,
          ...authoringTools,
        ];
      });
    },
    start: () => dependencies.lifecycle?.start?.(),
    stop: () => dependencies.lifecycle?.stop?.(),
  };
}
