/**
 * 内核线事件契约（标量壳）—— agent-protocol 协议面。
 *
 * 背景：SDK 内核产扁平 KernelEvent（camelCase），消费端把它翻译成线协议 Envelope。
 * 翻译"运行时语义事件 → Envelope"是协议契约的一部分，故事件契约下沉本包、
 * 与 Envelope 同居协议面（合约不变则模块可替换）。
 *
 * 零下层依赖约束：本文件禁 import @ragsystem/agent-llm。为此把携带 ChatMessage 的
 * 3 个事件（assistant_intermediate / observation_complete / intent_complete）**剥成标量壳**——
 * 翻译成 Envelope 时本就用不到 message 字段（前两者翻译为空，intent_complete 只读 content/round）。
 * ChatMessage 持久化由 SDK Dispatcher 用内核内部完整事件（agent-sdk 的 KernelEvent extends 本壳 + 补 message）完成。
 *
 * 命名：成员类型仍以 ...Event 结尾、字段 camelCase（与 agent-sdk KernelEvent 同构，便于 extends 复用）。
 * agent-sdk 的完整 KernelEvent 通过 extends 本壳扩展 message 字段，单一真相、无类型重复。
 */

/* ============================================================
 * 一、标量事件壳（10 种，ChatMessage-free）
 * ========================================================== */

export interface FirstTokenEvent {
  type: "first_token";
  agentName: string;
  elapsedMs: number;
}

export interface OutputDeltaEvent {
  type: "output_delta";
  agentName: string;
  content: string;
}

export interface IntentDeltaEvent {
  type: "intent_delta";
  agentName: string;
  content: string;
  round: number;
}

/**
 * intent 完成壳（标量）。完整事件在 agent-sdk 补 assistantMessage（Dispatcher 据此落 intent message），
 * 翻译成 Envelope 时只读 content/round/agentName，故壳不含 message。
 */
export interface IntentCompleteEvent {
  type: "intent_complete";
  agentName: string;
  content: string;
  round: number;
}

/** assistant 中间态壳（标量）。完整事件在 agent-sdk 补 message；翻译为空，壳留作穷尽 switch 不塌。 */
export interface AssistantIntermediateEvent {
  type: "assistant_intermediate";
  agentName: string;
  round: number;
}

export interface ToolCallEvent {
  type: "tool_call";
  agentName: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  round: number;
  order: number;
  roundIndex: number;
}

export interface ToolResultEvent {
  type: "tool_result";
  agentName: string;
  toolCallId: string;
  toolName: string;
  success: boolean;
  summary: string;
  observation: string;
  metadata: Record<string, unknown>;
  elapsedTime: number;
  round: number;
  order: number;
  roundIndex: number;
}

/** observation 完成壳（标量）。完整事件在 agent-sdk 补 messages；翻译为空，壳留作穷尽 switch 不塌。 */
export interface ObservationCompleteEvent {
  type: "observation_complete";
  agentName: string;
  round: number;
}

export interface RuntimeErrorEvent {
  type: "error";
  agentName: string;
  message: string;
}

/**
 * 上下文用量遥测壳（标量）。每轮请求消息组好后报一次；翻译推 state_sync(context_usage)。
 * budgetTokens 由 createRuntime 注入的纯函数算，各 token 分桶由 estimateTokens 估算。
 */
export interface ContextUsageEvent {
  type: "context_usage";
  agentName: string;
  round: number;
  systemPromptTokens: number;
  historyTokens: number;
  totalTokens: number;
  budgetTokens: number;
  compressing: boolean;
}

/** 内核线事件（标量壳 union，翻译投影用）。 */
export type KernelWireEvent =
  | FirstTokenEvent
  | OutputDeltaEvent
  | IntentDeltaEvent
  | IntentCompleteEvent
  | AssistantIntermediateEvent
  | ToolCallEvent
  | ToolResultEvent
  | ObservationCompleteEvent
  | RuntimeErrorEvent
  | ContextUsageEvent;

/* ============================================================
 * 二、翻译上下文（纯标量，无 IO）
 * ========================================================== */

/**
 * 把 KernelWireEvent 投影成 Envelope 所需的执行上下文（与 backend-ts 翻译点对齐）。
 *
 * parentCallId：父 agent 的 call_id（child run 非空，root run 为空）——agent-protocol
 * execution-tree 据此把子 agent 嵌套到父；缺失则子 agent 沦为平级 root。
 *
 * 注意：tool_call/tool_result 的 payload.lineage.parent_call_id 固定取 rootCallId（非 parentCallId）——
 * 投影树按"工具挂在当前 agent 的 root call 下"组织，保持旧实现这一易错细节。
 */
export interface WireTranslationContext {
  sessionId: string;
  runId: string;
  /** 当前 run 的 root call id（stream_output/tool 帧顶层 call_id + tool lineage 基准）。 */
  rootCallId: string;
  /** 调用点请求 id（用户侧幂等键）；context_usage 遥测透传，供调用点追踪。 */
  requestId: string;
  agentId: string;
  /** agent 展示名（中文等）；UI 显示用。 */
  agentDisplayName: string;
  /** 父 agent 的 call_id；root run 为空。 */
  parentCallId?: string | null;
}
