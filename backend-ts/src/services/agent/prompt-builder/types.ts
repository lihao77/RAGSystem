import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { RuntimeToolDefinition } from "@ragsystem/agent-sdk";

export interface AgentPromptSkill {
  name: string;
  description?: string | null | undefined;
}

export interface AgentPromptDelegatedAgent {
  agent_name: string;
  display_name?: string | null | undefined;
  description?: string | null | undefined;
  use_cases?: unknown;
  tool_count?: number | null | undefined;
}

export interface AgentPromptContext {
  tools?: RuntimeToolDefinition[] | undefined;
  skills?: AgentPromptSkill[] | undefined;
  delegatedAgents?: AgentPromptDelegatedAgent[] | undefined;
}

export interface AgentPromptConfigResolver {
  getConfig(agentName: string, options?: { teamName?: string | null }): AgentConfig | null;
  listAvailableSkills?(): unknown[];
}

/**
 * 工具指令形态：决定 prompt 注入哪种协议说明。
 * - "xml"：注入完整 XML 协议说明（含 <tool_calls> 用法 + tool_manifest），工具走 XML 文本协议。
 * - "native"：注入混合协议说明（仅 <intent>/<final_answer>），工具走厂商 function calling。
 *
 * 与 SDK @ragsystem/agent-sdk 的 ToolInstructionMode 同义；此处保留 backend-ts prompt-builder
 * 本地类型，供 monitoring/调试与 token 估算场景在不经 SDK 运行时的情况下构建提示词。
 */
export type ToolInstructionMode = "xml" | "native";
