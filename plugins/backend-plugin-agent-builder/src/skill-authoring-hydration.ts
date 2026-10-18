import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";

const ALIASES: Record<string, string> = {
  list_skill_drafts: "list_skills", get_skill_draft: "get_skill",
  create_skill_draft: "create_skill", publish_skill_draft: "save_skill",
};

/** Shape-driven migration, including hand-edited and partially upgraded Builder configurations. */
export function hydrateSkillAuthoring(configs: Record<string, AgentConfig>, instruction: string, previous: Record<string, AgentConfig> = configs): Record<string, AgentConfig> | null {
  const current = configs.builder_orchestrator;
  if (!current) return null;
  const params = isRecord(current.custom_params) ? current.custom_params : {};
  const behavior = isRecord(params.behavior) ? params.behavior : {};
  const original = typeof behavior.system_prompt === "string" ? behavior.system_prompt : "";
  let prompt = original.replace(/Use list_skill_drafts, with a query when needed[\s\S]*?A Skill is not available to Agents until publication succeeds\./g, instruction);
  // Replace only the managed contract, preserving the user's surrounding instructions.
  // Shape-driven: current-version and partially updated configurations also converge.
  const marker = "Skill authoring runtime contract:";
  const managed = /Skill authoring runtime contract:[\s\S]*?A Skill becomes available to Agents when saving succeeds\./g;
  prompt = prompt.replace(managed, (block) =>
    instruction.includes(marker) && /execute_skill_script|load_skill_resource|runtime executes Python only/.test(block)
      ? instruction.slice(instruction.indexOf(marker)) : block,
  );
  for (const [retired, name] of Object.entries(ALIASES)) prompt = prompt.replaceAll(retired, name);
  prompt = prompt.replaceAll("Skill drafts", "Skills").replaceAll("Skill 草稿", "Skill");
  if (!prompt.includes("Skill direct-save workflow:")) prompt = `${prompt} ${instruction}`.trim();
  const tools = [...new Set(current.tools.enabled_tools.map((tool) => ALIASES[tool] ?? tool))];
  for (const tool of Object.values(ALIASES)) if (!tools.includes(tool)) tools.push(tool);
  const prior = previous.builder_orchestrator;
  const priorBehavior = isRecord(prior?.custom_params?.behavior) ? prior.custom_params.behavior : {};
  const priorComplete = String(priorBehavior.system_prompt ?? "").includes("Skill direct-save workflow:")
    && Object.values(ALIASES).every((tool) => prior?.tools.enabled_tools.includes(tool))
    && !prior?.tools.enabled_tools.some((tool) => Object.hasOwn(ALIASES, tool));
  if (priorComplete && prompt === original && JSON.stringify(tools) === JSON.stringify(current.tools.enabled_tools)) return null;
  return { ...configs, builder_orchestrator: { ...current, tools: { ...current.tools, enabled_tools: tools },
    custom_params: { ...params, behavior: { ...behavior, system_prompt: prompt,
      skill_authoring_migration: { id: "builder_skill_direct_save", applied_at: new Date().toISOString() },
    } },
  } };
}
