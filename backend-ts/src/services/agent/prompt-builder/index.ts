/**
 * prompt context 算取入口——backend-ts 侧消费端（context-snapshot / runtime-adapter）算 AgentPromptContext。
 *
 * system prompt 拼装（sections/buildFullSystemPrompt）已下沉 SDK（agent-sdk prompt 模块，与内核 makeContextPort
 * 同源）。skill / delegation 的可用清单不再走 context——由对应工具（skill 工具、call_agent）以 enum +
 * extended_usage 自描述，统一进 tools 段。故 buildAgentPromptContext 只剩 tools + backgroundTasks。
 */
import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { RuntimeToolDefinition } from "@ragsystem/agent-sdk";
import type { AgentPromptContext } from "./types.js";

export type { AgentPromptContext, ToolInstructionMode } from "./types.js";

export function buildAgentPromptContext(input: {
  agent: AgentConfig;
  /** 已为该 agent 解析的工具定义列表（调用方用 createBackendTools + toolToDefinition 准备，已含 skill/delegation 自描述）。 */
  tools?: RuntimeToolDefinition[] | null | undefined;
}): AgentPromptContext {
  const tools = input.tools ?? [];
  return {
    tools,
    ...(input.agent.tasks.background ? { backgroundTasks: true } : {}),
  };
}
