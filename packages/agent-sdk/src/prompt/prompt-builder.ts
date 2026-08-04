/**
 * buildFullSystemPrompt（设计稿 §7，完整版——与 backend-ts 同源）。
 * 只读 profile.behavior.systemPrompt（经 getAgentBaseSystemPrompt），其余 profile 字段（tier/memory 等）不参与
 * prompt 构建——故 profile 类型放宽为 Pick<AgentProfile, "behavior">，让调试/preview 场景无需完整 tier 投影。
 * skill / delegation 的可用清单由对应工具（skill 工具、call_agent）自行以 enum + extended_usage 自描述，
 * 走统一的 tools 段；内核不再持有领域概念。工具参数（含 run_in_background）的可见性由消费端工具工厂按 agent 能力决定，内核原样消费。
 */
import type { AgentProfile } from "../types.js";
import type { ToolInstructionMode } from "../contracts.js";
import type { AgentPromptContext } from "./types.js";
import { collectSections, normalizeString } from "./types.js";
import {
  buildDataFileRulesSection,
  buildExecutionPathsSection,
  buildPromptActionsSection,
  buildPromptDoingTasksSection,
  buildPromptGoalSection,
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
  return collectSections([
    buildPromptGoalSection(),
    buildPromptDoingTasksSection(),
    buildPromptPrinciplesSection(mode),
    buildPromptActionsSection(mode),
    getAgentBaseSystemPrompt(profile),
    buildExecutionPathsSection(context.executionPaths),
    buildPromptToolsSection(tools, mode),
    buildPromptRulesSection(mode),
    buildDataFileRulesSection(),
  ]).join("\n\n");
}
