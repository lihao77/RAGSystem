import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { provideCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";

import { SKILLS_RUNTIME_CAPABILITY } from "./capability.js";
import type { SkillsPluginDependencies } from "./dependencies.js";
import { registerSkillRoutes } from "./routes.js";
import { createSkillTools } from "./tools/SkillTools.js";
import {
  createSkillAuthoringTools,
  SKILL_AUTHORING_TOOL_DESCRIPTORS,
} from "./tools/SkillAuthoringTools.js";

export const SKILLS_PLUGIN_ID = "@ragsystem/backend-plugin-skills";

export function createSkillsPlugin(dependencies: SkillsPluginDependencies): BackendPlugin {
  return {
    manifest: { id: SKILLS_PLUGIN_ID, version: "0.1.0" },
    register(context) {
      context.runtimes.register(async (runtimeContext) => {
        const runtime = await dependencies.runtimeFactory(runtimeContext);
        return {
          capabilities: [provideCapability(SKILLS_RUNTIME_CAPABILITY, runtime)],
          ...(runtime.dispose ? { dispose: () => runtime.dispose?.() } : {}),
        };
      });
      context.routes.register("tenant", "/api/skills", async (app) => {
        await app.register(registerSkillRoutes);
      });
      context.tools.register(async ({ agent, teamName, capabilities }) => {
        if (!capabilities) throw new Error("Skills plugin requires runtime capabilities");
        const runtime = capabilities.require(SKILLS_RUNTIME_CAPABILITY);
        await runtime.tools.hydrateUserGlobalPackages();
        const config = await runtime.agentConfig.getEffective({
          teamName: teamName ?? "default",
          agentName: agent.agent_name,
        });
        const usageTools = createSkillTools({ skillTools: runtime.tools, agent, config });
        const enabledTools = new Set(agent.tools.enabled_tools);
        return [
          ...usageTools,
          ...createSkillAuthoringTools({
            authoring: runtime.authoring,
            agentName: agent.agent_name,
          }).filter((tool) => enabledTools.has(tool.name)),
        ];
      }, SKILL_AUTHORING_TOOL_DESCRIPTORS);
    },
    start: () => dependencies.lifecycle?.start?.(),
    stop: () => dependencies.lifecycle?.stop?.(),
  };
}
