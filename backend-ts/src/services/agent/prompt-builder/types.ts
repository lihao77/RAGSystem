/**
 * prompt 上下文类型已下沉 SDK（agent-sdk prompt 模块）。本文件 re-export SDK 类型，
 * 供 backend-ts 消费端（context-snapshot / runtime-adapter 算 promptContext）使用。
 */
export type { AgentPromptContext } from "@ragsystem/agent-sdk";

export type { ToolInstructionMode } from "@ragsystem/agent-sdk";
