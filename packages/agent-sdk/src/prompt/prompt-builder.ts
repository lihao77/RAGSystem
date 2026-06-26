/**
 * buildFullSystemPrompt（设计稿 §7，完整版——与 backend-ts 同源）。
 * 只读 profile.behavior.systemPrompt（经 getAgentBaseSystemPrompt），其余 profile 字段（tier/memory 等）不参与
 * prompt 构建——故 profile 类型放宽为 Pick<AgentProfile, "behavior">，让调试/preview 场景无需完整 tier 投影。
 * skill / delegation 的可用清单由对应工具（skill 工具、call_agent）自行以 enum + extended_usage 自描述，
 * 走统一的 tools 段；内核不再持有这两个领域概念。backgroundTasks 仍是内核级开关（裁剪 run_in_background）。
 */
import type { AgentProfile } from "../types.js";
import type { ToolInstructionMode } from "../contracts.js";
import type { AgentPromptContext } from "./types.js";
import { collectSections, normalizeString } from "./types.js";
import { prepareToolsForPrompt } from "./tool-format.js";
import {
  buildDataFileRulesSection,
  buildPromptActionsSection,
  buildPromptDoingTasksSection,
  buildPromptGoalSection,
  buildPromptOutputFormatSection,
  buildPromptPrinciplesSection,
  buildPromptRulesSection,
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
    buildPromptOutputFormatSection(toolNames, mode),
    buildPromptRulesSection(mode),
    buildDataFileRulesSection(),
  ]).join("\n\n");
}
