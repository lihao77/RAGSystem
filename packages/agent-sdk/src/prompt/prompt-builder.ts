/**
 * buildFullSystemPrompt（设计稿 §7，迁自 backend-ts）。
 * 读 profile.behavior.systemPrompt（解耦 AgentConfig.custom_params.behavior）；
 * skill/delegation section 不产出（profile 不含这些衍生字段）。
 */
import type { AgentProfile } from "../types.js";
import type { ToolInstructionMode } from "../contracts.js";
import type { AgentPromptContext } from "./types.js";
import { collectSections, isRecord, normalizeString } from "./types.js";
import { prepareToolsForPrompt } from "./tool-format.js";
import { buildPromptActionsSection } from "./sections.js";
import { buildPromptDoingTasksSection } from "./sections.js";
import { buildPromptGoalSection } from "./sections.js";
import { buildPromptOutputFormatSection } from "./sections.js";
import { buildPromptPrinciplesSection } from "./sections.js";
import { buildPromptRulesSection } from "./sections.js";
import { buildPromptSystemSection } from "./sections.js";
import { buildPromptToolsSection } from "./sections.js";
import { buildCodeExecutionPromptSection } from "./sections.js";
import { buildDataFileRulesSection } from "./sections.js";

export function buildFullSystemPrompt(
  profile: AgentProfile,
  context: AgentPromptContext = {},
  mode: ToolInstructionMode = "xml",
): string {
  const staticPart = collectSections([buildPromptSystemSection()]).join("\n\n");
  const dynamicPart = buildDynamicSystemPrompt(profile, context, mode);
  return collectSections([staticPart, dynamicPart]).join("\n\n");
}

export function getAgentBaseSystemPrompt(profile: AgentProfile): string {
  return normalizeString(profile.behavior.systemPrompt) ?? "";
}

function buildDynamicSystemPrompt(
  profile: AgentProfile,
  context: AgentPromptContext,
  mode: ToolInstructionMode,
): string {
  const tools = context.tools ?? [];
  const toolNames = new Set(tools.map((tool) => tool.name));
  const promptTools = prepareToolsForPrompt(tools);
  return collectSections([
    buildPromptGoalSection(toolNames),
    buildPromptDoingTasksSection(toolNames),
    buildPromptPrinciplesSection(toolNames, mode),
    buildPromptActionsSection(toolNames, mode),
    getAgentBaseSystemPrompt(profile),
    buildPromptToolsSection(promptTools, mode),
    buildCodeExecutionPromptSection(promptTools),
    buildPromptOutputFormatSection(toolNames, mode),
    buildPromptRulesSection(toolNames, mode),
    buildDataFileRulesSection(toolNames, mode),
  ]).join("\n\n");
}

void isRecord;
