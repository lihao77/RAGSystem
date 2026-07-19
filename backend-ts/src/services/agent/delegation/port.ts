import type { ToolExecContext, ToolExecutionResult } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../../contracts/agent/agent-config.js";

/**
 * 委派能力契约(DelegationPort)。
 *
 * 工具层(DelegationTools)与运行时工具桥(RuntimeToolBridge)依赖本接口调用委派能力;
 * AgentDelegationService 实现之。把"具体类耦合"收敛到接口——与对侧 RuntimeToolExecutor
 * (委派方依赖工具执行器的抽象)对称,消除 runtime-tool-bridge ↔ AgentDelegationService
 * 的具体类型耦合。
 *
 * 双向引用本身(工具需派生子 agent、子 agent 复用工具执行器)是领域循环,仍由 container
 * 的 setter 注入打破;本接口只消除类型耦合,不改引用方向。
 *
 * 父 Agent 配置不再从 ctx.agent 读取(SDK ToolExecContext 无 agent 字段),
 * 由调用方(工厂闭包)作为显式入参传入。
 */
export interface AgentDelegationInput {
  agentName: string;
  task: string;
  contextHint?: string | null | undefined;
  callId?: string | null | undefined;
}

export interface SendMessageInput {
  childAgentId: string;
  message: string;
  callId?: string | null | undefined;
}

export interface ListChildAgentsInput {
  agentName?: string | null | undefined;
  limit?: number | null | undefined;
}

export interface AgentDelegationCall {
  agent: AgentConfig;
  /** 当前 session 的 team（解析 child agent 展示名用）；SDK ToolExecContext 不携带，由调用方注入。 */
  teamName: string | null;
  input: AgentDelegationInput;
}

export interface SendMessageCall {
  agent: AgentConfig;
  teamName: string | null;
  input: SendMessageInput;
}

export interface ListChildAgentsCall {
  agent: AgentConfig;
  teamName: string | null;
  input: ListChildAgentsInput;
}

export interface DelegationPort {
  callAgent(call: AgentDelegationCall, ctx: ToolExecContext): Promise<ToolExecutionResult>;
  sendMessage(call: SendMessageCall, ctx: ToolExecContext): Promise<ToolExecutionResult>;
  listChildAgents(call: ListChildAgentsCall, ctx: ToolExecContext): ToolExecutionResult;
}
