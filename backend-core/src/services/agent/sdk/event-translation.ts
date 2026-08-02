import type {
  ContextUsageEvent,
  FirstTokenEvent,
  IntentCompleteEvent,
  IntentDeltaEvent,
  KernelEvent,
  ModelRequestEvent,
  OutputDeltaEvent,
  RuntimeErrorEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@ragsystem/agent-sdk";
import type {
  Envelope,
  ModelRequestPayload,
  StateSyncPayload,
  StreamOutputPayload,
  ToolCallPayload,
  ToolResultPayload,
} from "../../../contracts/events.js";

/** Host data required to project an SDK event onto the client wire protocol. */
export interface WireTranslationContext {
  sessionId: string;
  runId: string;
  rootCallId: string;
  requestId: string;
  agentId: string;
  parentCallId?: string | null;
}

/** Translate one SDK event into the envelopes visible to this backend's clients. */
export function translateKernelEvent(event: KernelEvent, ctx: WireTranslationContext): Envelope[] {
  switch (event.type) {
    case "model_request":
      return [onModelRequest(event, ctx)];
    case "first_token":
      return [onFirstToken(event, ctx)];
    case "output_delta":
      return [onOutputDelta(event, ctx)];
    case "intent_delta":
      return [onIntentDelta(event, ctx)];
    case "intent_complete":
      return [onIntentComplete(event, ctx)];
    case "tool_call":
      return [onToolCall(event, ctx)];
    case "tool_result":
      return [onToolResult(event, ctx)];
    case "error":
      return [onError(event, ctx)];
    case "context_usage":
      return [onContextUsage(event, ctx)];
    case "assistant_intermediate":
      return [];
    default: {
      const exhaustive: never = event;
      void exhaustive;
      return [];
    }
  }
}

function topMarkers(ctx: WireTranslationContext): {
  session_id: string;
  run_id: string;
  call_id: string;
  agent_id: string;
} {
  return { session_id: ctx.sessionId, run_id: ctx.runId, call_id: ctx.rootCallId, agent_id: ctx.agentId };
}

function toolLineage(ctx: WireTranslationContext): { parent_call_id?: string } {
  return { parent_call_id: ctx.rootCallId };
}

function streamLineage(ctx: WireTranslationContext): { lineage?: { parent_call_id: string } } {
  return ctx.parentCallId ? { lineage: { parent_call_id: ctx.parentCallId } } : {};
}

function onModelRequest(event: ModelRequestEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "model_request",
    ...topMarkers(ctx),
    payload: { phase: "start", round: event.round, ...streamLineage(ctx) } satisfies ModelRequestPayload,
  };
}

function onFirstToken(event: FirstTokenEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "stream_output",
    ...topMarkers(ctx),
    payload: { phase: "first_token", elapsed_ms: event.elapsedMs, ...streamLineage(ctx) } satisfies StreamOutputPayload,
  };
}

function onOutputDelta(event: OutputDeltaEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "stream_output",
    ...topMarkers(ctx),
    payload: { phase: "delta", content: event.content, ...streamLineage(ctx) } satisfies StreamOutputPayload,
  };
}

function onIntentDelta(event: IntentDeltaEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "stream_output",
    ...topMarkers(ctx),
    payload: { phase: "intent_delta", content: event.content, round: event.round, ...streamLineage(ctx) } satisfies StreamOutputPayload,
  };
}

function onIntentComplete(event: IntentCompleteEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "stream_output",
    ...topMarkers(ctx),
    payload: { phase: "intent_complete", content: event.content, round: event.round, ...streamLineage(ctx) } satisfies StreamOutputPayload,
  };
}

function onToolCall(event: ToolCallEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "tool_call",
    session_id: ctx.sessionId,
    run_id: ctx.runId,
    call_id: event.toolCallId,
    agent_id: ctx.agentId,
    payload: {
      tool: event.toolName,
      input: event.arguments,
      phase: "start",
      status: "running",
      round: event.round,
      lineage: toolLineage(ctx),
    } satisfies ToolCallPayload,
  };
}

function onToolResult(event: ToolResultEvent, ctx: WireTranslationContext): Envelope {
  const approvalMessage = asString(event.metadata.approval_message);
  const approvalMeta = isRecord(event.metadata.approval) ? event.metadata.approval : null;
  const approvalStatus = asString(approvalMeta?.status);
  const base: ToolResultPayload = {
    tool: event.toolName,
    phase: "end",
    ok: event.success,
    status: event.success ? "succeeded" : "failed",
    observation: event.observation,
    summary: event.summary,
    lineage: toolLineage(ctx),
  };
  if (typeof event.elapsedTime === "number") {
    base.elapsed_ms = event.elapsedTime * 1000;
  }
  if (approvalStatus === "pending" || approvalStatus === "granted" || approvalStatus === "denied") {
    base.approval = { status: approvalStatus, ...(approvalMessage ? { message: approvalMessage } : {}) };
  }
  return {
    type: "tool_result",
    session_id: ctx.sessionId,
    run_id: ctx.runId,
    call_id: event.toolCallId,
    agent_id: ctx.agentId,
    payload: base,
  };
}

function onError(event: RuntimeErrorEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "error",
    ...topMarkers(ctx),
    payload: { code: "RuntimeError", message: event.message },
  };
}

function onContextUsage(event: ContextUsageEvent, ctx: WireTranslationContext): Envelope {
  const payload: StateSyncPayload = {
    category: "context_usage",
    detail: {
      agent_name: event.agentName,
      round: event.round,
      system_prompt_tokens: event.systemPromptTokens,
      history_tokens: event.historyTokens,
      used_tokens: event.totalTokens,
      total_tokens: event.totalTokens,
      budget_tokens: event.budgetTokens,
      compressing: event.compressing,
      request_id: ctx.requestId,
    },
  };
  return {
    type: "state_sync",
    ...topMarkers(ctx),
    payload,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
