import type { ChatMessage } from "@ragsystem/agent-llm";
import type { AssistantContentPart } from "./assistant-content.js";

export interface ModelRequestEvent {
  type: "model_request";
  agentName: string;
  round: number;
}

interface ModelAttemptEventBase {
  agentName: string;
  round: number;
  attemptId: string;
  attempt: number;
  maxAttempts: number;
  provider: string;
  model: string;
}

export interface ModelAttemptStartedEvent extends ModelAttemptEventBase {
  type: "model_attempt_started";
}

export interface ModelAttemptFailedEvent extends ModelAttemptEventBase {
  type: "model_attempt_failed";
  willRetry: boolean;
  retryDelayMs?: number;
  elapsedMs: number;
  error: string;
}

export interface ModelAttemptCompletedEvent extends ModelAttemptEventBase {
  type: "model_attempt_completed";
  elapsedMs: number;
}

/** Events emitted by the agent runtime and consumed by its host. */
export interface FirstTokenEvent {
  type: "first_token";
  agentName: string;
  elapsedMs: number;
}

export interface OutputDeltaEvent {
  type: "output_delta";
  agentName: string;
  content: string;
  partIndex: number;
}

export interface OutputFileRefEvent {
  type: "output_file_ref";
  agentName: string;
  partIndex: number;
  part: Extract<AssistantContentPart, { type: "file_ref" }>;
}

export interface IntentDeltaEvent {
  type: "intent_delta";
  agentName: string;
  content: string;
  round: number;
}

export interface IntentCompleteEvent {
  type: "intent_complete";
  agentName: string;
  content: string;
  round: number;
  /** Host persistence uses the complete assistant message when available. */
  assistantMessage?: ChatMessage;
}

export interface AssistantIntermediateEvent {
  type: "assistant_intermediate";
  agentName: string;
  round: number;
  message: ChatMessage;
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
  /** Durable subset used to restore same-round {result_N} references after a process restart. */
  referenceResult: Record<string, unknown>;
  elapsedTime: number;
  round: number;
  order: number;
  roundIndex: number;
}

export interface RuntimeErrorEvent {
  type: "error";
  agentName: string;
  message: string;
}

export interface ContextUsageSnapshot {
  systemPromptTokens: number;
  historyTokens: number;
  totalTokens: number;
  budgetTokens: number;
  compressing: boolean;
  /** 工具 schema 总 token（native tools；systemPromptTokens 已含此项）。 */
  toolSchemaTokens?: number;
  /** source=mcp 的工具 schema token（估算，构成占比展示用）。 */
  mcpToolTokens?: number;
  /** source=knowledge 的工具 schema token（技能工具，估算）。 */
  knowledgeToolTokens?: number;
  /** 本 run 累计缓存读取 token（provider 实测，仅 provider 事件携带）。 */
  cachedInputTokens?: number;
  /** 本 run 累计缓存写入 token（provider 实测，仅 provider 事件携带）。 */
  cacheCreationInputTokens?: number;
  /** 本 run 累计输入 token（含缓存部分，provider 实测）。 */
  inputTokens?: number;
}

export interface ContextUsageEvent extends ContextUsageSnapshot {
  type: "context_usage";
  agentName: string;
  round: number;
  source?: "estimate" | "provider";
}

/** Complete event union exposed through RunHandle.events. */
export type KernelEvent =
  | ModelRequestEvent
  | ModelAttemptStartedEvent
  | ModelAttemptFailedEvent
  | ModelAttemptCompletedEvent
  | FirstTokenEvent
  | OutputDeltaEvent
  | OutputFileRefEvent
  | IntentDeltaEvent
  | IntentCompleteEvent
  | AssistantIntermediateEvent
  | ToolCallEvent
  | ToolResultEvent
  | RuntimeErrorEvent
  | ContextUsageEvent;
