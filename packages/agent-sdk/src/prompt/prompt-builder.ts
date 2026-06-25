/**
 * buildFullSystemPrompt（设计稿 §7，完整版——与 backend-ts 同源）。
 * 只读 profile.behavior.systemPrompt（经 getAgentBaseSystemPrompt），其余 profile 字段（tier/memory 等）不参与
 * prompt 构建——故 profile 类型放宽为 Pick<AgentProfile, "behavior">，让调试/preview 场景无需完整 tier 投影。
 * skills/delegation/background 段消费 AgentPromptContext 里的纯展示数据（消费端算好注入）。
 */
import type { AgentProfile } from "../types.js";
import type { ToolInstructionMode } from "../contracts.js";
import type { AgentPromptContext } from "./types.js";
import { collectSections, normalizeString } from "./types.js";
import { prepareToolsForPrompt } from "./tool-format.js";
import {
  buildAgentSpecificPromptSections,
  buildDataFileRulesSection,
  buildPromptActionsSection,
  buildPromptDoingTasksSection,
  buildPromptGoalSection,
  buildPromptOutputFormatSection,
  buildPromptPrinciplesSection,
  buildPromptRulesSection,
  buildPromptSkillsSection,
  buildPromptSystemSection,
  buildPromptToolsSection,
} from "./sections.js";

/** prompt 构建只需 behavior.systemPrompt；放宽 profile 类型，调试/preview 无需完整 tier 投影。 */
type PromptProfile = Pick<AgentProfile, "behavior">;

export function buildFullSystemPrompt(
  profile: PromptProfile,
  context: AgentPromptContext = {},
  mode: ToolInstructionMode = "xml",
): string {
  const staticPart = collectSections([buildPromptSystemSection()]).join("\n\n");
  const dynamicPart = buildDynamicSystemPrompt(profile, context, mode);
  return collectSections([staticPart, dynamicPart]).join("\n\n");
}

export function getAgentBaseSystemPrompt(profile: PromptProfile): string {
  return normalizeString(profile.behavior.systemPrompt) ?? "";
}

function buildDynamicSystemPrompt(profile: PromptProfile, context: AgentPromptContext, mode: ToolInstructionMode): string {
  const tools = context.tools ?? [];
  const toolNames = new Set(tools.map((tool) => tool.name));
  const promptTools = prepareToolsForPrompt(tools, context.backgroundTasks ?? false);
  return collectSections([
    buildPromptGoalSection(),
    buildPromptDoingTasksSection(),
    buildPromptPrinciplesSection(mode),
    buildPromptActionsSection(mode),
    getAgentBaseSystemPrompt(profile),
    buildPromptToolsSection(promptTools, mode),
    buildPromptSkillsSection(context.skills ?? []),
    ...buildAgentSpecificPromptSections(context.delegatedAgents ?? [], mode),
    buildPromptOutputFormatSection(toolNames, mode),
    buildPromptRulesSection(mode),
    buildDataFileRulesSection(),
  ]).join("\n\n");
}
