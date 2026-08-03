import type { ChatMessage } from "@ragsystem/agent-llm";

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

/** Complete event union exposed through RunHandle.events. */
export type KernelEvent =
  | ModelRequestEvent
  | ModelAttemptStartedEvent
  | ModelAttemptFailedEvent
  | ModelAttemptCompletedEvent
  | FirstTokenEvent
  | OutputDeltaEvent
  | IntentDeltaEvent
  | IntentCompleteEvent
  | AssistantIntermediateEvent
  | ToolCallEvent
  | ToolResultEvent
  | RuntimeErrorEvent
  | ContextUsageEvent;
