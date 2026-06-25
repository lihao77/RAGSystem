/**
 * prompt context 算取入口——backend-ts 侧消费端（context-snapshot / runtime-adapter）算 AgentPromptContext。
 *
 * system prompt 拼装（sections/buildFullSystemPrompt）已下沉 SDK（agent-sdk prompt 模块，与内核 makeContextPort
 * 同源）。本模块只保留"算 context"：skills/delegatedAgents 依赖 backend-ts agentConfig 容器（listAvailableSkills/
 * getConfig），不下沉。buildAgentPromptContext 产出 SDK AgentPromptContext，喂给 SDK buildFullSystemPrompt / previewLlmRequest。
 */
import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { RuntimeToolDefinition } from "@ragsystem/agent-sdk";
import type { AgentPromptConfigResolver, AgentPromptContext } from "./types.js";
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
  /** 已为该 agent 解析的工具定义列表（调用方用 createBackendTools + toolToDefinition 准备）。 */
  tools?: RuntimeToolDefinition[] | null | undefined;
  configResolver?: AgentPromptConfigResolver | null | undefined;
  teamName?: string | null | undefined;
}): AgentPromptContext {
  const tools = input.tools ?? [];
  const hasDelegation = tools.some(
    (tool) => tool.name === "call_agent" || tool.name === "list_child_agents" || tool.name === "send_message",
  );
  return {
    tools,
    skills: buildPromptSkills(input.agent, input.configResolver),
    delegatedAgents: hasDelegation
      ? buildPromptDelegatedAgents(input.agent, input.configResolver, input.teamName)
      : [],
    ...(input.agent.tasks.background ? { backgroundTasks: true } : {}),
  };
}
