import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { provideCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";
import { provideAgentCapability } from "@ragsystem/backend-core/plugins/agent-capability-provider.js";

import { SKILLS_RUNTIME_CAPABILITY } from "./capability.js";
import type { SkillsPluginDependencies } from "./dependencies.js";
import { registerSkillRoutes } from "./routes.js";
import { createSkillTools } from "./tools/SkillTools.js";
import { createSkillAuthoringTools } from "./tools/SkillAuthoringTools.js";
import { registerRetiredToolNames } from "@ragsystem/backend-core/contracts/agent/tool-name-aliases.js";
import { SKILL_AUTHORING_TOOL_DESCRIPTORS } from "./tools/SkillAuthoringTools.js";

export const SKILLS_PLUGIN_ID = "@ragsystem/backend-plugin-skills";

/** get_capability_detail 内联正文预览与文件名清单的上限，防止大 SKILL.md 撑爆构建方上下文。 */
const SKILL_DETAIL_CONTENT_LIMIT = 4_000;
const SKILL_DETAIL_FILE_LIMIT = 50;

export function createSkillsPlugin(dependencies: SkillsPluginDependencies): BackendPlugin {
  return {
    manifest: { id: SKILLS_PLUGIN_ID, version: "0.2.0" },
    register(context) {
      for (const tool of SKILL_AUTHORING_TOOL_DESCRIPTORS) registerRetiredToolNames(tool.name, tool.retired_names ?? []);
      context.runtimes.register(async (runtimeContext) => {
        const runtime = await dependencies.runtimeFactory(runtimeContext);
        return {
          capabilities: [
            provideCapability(SKILLS_RUNTIME_CAPABILITY, runtime),
            provideAgentCapability({
              id: "skills",
              display_name: "技能",
              usage_note: "为 Agent 绑定 Skill 后，运行时会自动注入 activate_skill / load_skill_resource / execute_skill_script 工具（无需也无法在 tools 中声明它们）；注入形态是 3 个工具定义，占用固定少量 token，SKILL.md 正文不常驻系统提示词，仅在 Agent 调用 activate_skill 时按需加载。未绑定 Skill 的 Agent 不会看到这些工具入口。",
              listItems: async () => {
                const items = await runtime.library.listSkills();
                const infos = new Map(
                  (runtime.tools?.loadAllSkills?.() ?? []).map((info) => [info.name, info]),
                );
                return items.map((item) => {
                  const requires = infos.get(item.name)?.requires;
                  return {
                    name: item.name,
                    display_name: item.display_name,
                    description: item.description,
                    ...(requires ? { metadata: { requires } } : {}),
                  };
                });
              },
              getItemDetail: async (name) => {
                try {
                  const detail = await runtime.library.getSkillDetail(name);
                  const files = detail.files.filter((file) => file.type === "file");
                  return {
                    name: detail.name,
                    display_name: detail.display_name,
                    description: detail.description,
                    detail: {
                      source_type: detail.source_type,
                      content_preview: detail.content.length > SKILL_DETAIL_CONTENT_LIMIT
                        ? `${detail.content.slice(0, SKILL_DETAIL_CONTENT_LIMIT)}…`
                        : detail.content,
                      content_truncated: detail.content.length > SKILL_DETAIL_CONTENT_LIMIT,
                      files: files.slice(0, SKILL_DETAIL_FILE_LIMIT).map((file) => file.path),
                      note: "正文超长时只带预览；完整 SKILL.md 与资源文件用 get_skill 打开到会话工作区阅读。",
                    },
                  };
                } catch {
                  return null;
                }
              },
              getAgentConfig: async (teamName, agentName) =>
                (await runtime.agentConfig.getEffective({ teamName, agentName })).enabled_skills,
              putAgentConfig: async (teamName, agentName, names) => {
                await runtime.agentConfig.put(
                  { teamName, agentName },
                  { enabled_skills: [...names] },
                );
              },
            }, SKILLS_PLUGIN_ID),
          ],
          dispose: () => runtime.dispose?.(),
        };
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
            authorize: runtime.authorizeAuthoring,
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
