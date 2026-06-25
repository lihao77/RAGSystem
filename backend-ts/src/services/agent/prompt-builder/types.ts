import type { AgentConfig } from "../../../contracts/agent-config.js";

/**
 * prompt 上下文类型已下沉 SDK（agent-sdk prompt 模块）。本文件 re-export SDK 类型，
 * 供 backend-ts 消费端（context-snapshot / runtime-adapter 算 promptContext）使用。
 * backend-ts 只保留 AgentPromptConfigResolver 端口（依赖 agentConfig 容器，不下沉）。
 */
export type {
  AgentPromptContext,
  AgentPromptSkill,
  AgentPromptDelegatedAgent,
} from "@ragsystem/agent-sdk";

export type { ToolInstructionMode } from "@ragsystem/agent-sdk";

/**
 * agent 配置解析端口：backend-ts agentConfig 容器实现。
 * 算 promptContext 的 skills/delegatedAgents 时用（listAvailableSkills / getConfig），SDK 不依赖此端口。
 */
export interface AgentPromptConfigResolver {
  getConfig(agentName: string, options?: { teamName?: string | null }): AgentConfig | null;
  listAvailableSkills?(): unknown[];
}
