import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { RuntimeToolExecutor } from "../../runtime/runtime-tool-types.js";
import type { ToolInstructionMode } from "./types.js";
import type { AgentPromptConfigResolver, AgentPromptContext } from "./types.js";
import { collectSections, isRecord, normalizeString } from "./helpers.js";
import { prepareToolsForPrompt } from "./tool-format.js";
import {
  buildAgentSpecificPromptSections,
  buildCodeExecutionPromptSection,
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
  hasDelegationTools,
} from "./sections.js";
import { buildPromptDelegatedAgents, buildPromptSkills } from "./prompt-context.js";

export type {
  AgentPromptConfigResolver,
  AgentPromptContext,
  AgentPromptDelegatedAgent,
  AgentPromptSkill,
  ToolInstructionMode,
} from "./types.js";

export function buildAgentPromptContext(input: {
  agent: AgentConfig;
  toolExecutor?: RuntimeToolExecutor | null | undefined;
  configResolver?: AgentPromptConfigResolver | null | undefined;
  teamName?: string | null | undefined;
}): AgentPromptContext {
  const tools = input.toolExecutor?.listVisibleTools(input.agent) ?? [];
  return {
    tools,
    skills: buildPromptSkills(input.agent, input.configResolver),
    delegatedAgents: hasDelegationTools(tools)
      ? buildPromptDelegatedAgents(input.agent, input.configResolver, input.teamName)
      : [],
  };
}

export function buildFullSystemPrompt(agent: AgentConfig, context: AgentPromptContext = {}, mode: ToolInstructionMode = "xml"): string {
  const staticPart = buildStaticSystemPrompt();
  const dynamicPart = buildDynamicSystemPrompt(agent, context, mode);
  return collectSections([staticPart, dynamicPart]).join("\n\n");
}

export function getAgentBaseSystemPrompt(agent: AgentConfig): string {
  const behavior = agent.custom_params.behavior;
  if (!isRecord(behavior)) {
    return "";
  }
  return normalizeString(behavior.system_prompt) ?? "";
}

function buildStaticSystemPrompt(): string {
  return collectSections([
    buildPromptSystemSection(),
  ]).join("\n\n");
}

function buildDynamicSystemPrompt(agent: AgentConfig, context: AgentPromptContext, mode: ToolInstructionMode): string {
  const tools = context.tools ?? [];
  const toolNames = new Set(tools.map((tool) => tool.name));
  const promptTools = prepareToolsForPrompt(agent, tools);
  return collectSections([
    buildPromptGoalSection(toolNames),
    buildPromptDoingTasksSection(toolNames),
    buildPromptPrinciplesSection(toolNames, mode),
    buildPromptActionsSection(toolNames, mode),
    getAgentBaseSystemPrompt(agent),
    buildPromptToolsSection(agent, promptTools, mode),
    buildPromptSkillsSection(context.skills ?? []),
    buildCodeExecutionPromptSection(promptTools),
    ...buildAgentSpecificPromptSections(context.delegatedAgents ?? [], mode),
    buildPromptOutputFormatSection(toolNames, mode),
    buildPromptRulesSection(toolNames, mode),
    buildDataFileRulesSection(toolNames, mode),
  ]).join("\n\n");
}
