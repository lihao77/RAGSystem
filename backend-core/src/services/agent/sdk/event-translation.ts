import type {
  ContextUsageEvent,
  FirstTokenEvent,
  IntentCompleteEvent,
  IntentDeltaEvent,
  KernelEvent,
  ModelAttemptCompletedEvent,
  ModelAttemptFailedEvent,
  ModelAttemptStartedEvent,
  ModelRequestEvent,
  OutputDeltaEvent,
  OutputFileRefEvent,
  RuntimeErrorEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@ragsystem/agent-sdk";
import type {
  Envelope,
  ModelAttemptCompletedPayload,
  ModelAttemptFailedPayload,
  ModelAttemptStartedPayload,
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
  boundaryMessageId?: string | null;
}

/** Translate one SDK event into the envelopes visible to this backend's clients. */
export function translateKernelEvent(event: KernelEvent, ctx: WireTranslationContext): Envelope[] {
  switch (event.type) {
    case "model_request":
      return [onModelRequest(event, ctx)];
    case "model_attempt_started":
      return [onModelAttemptStarted(event, ctx)];
    case "model_attempt_failed":
      return [onModelAttemptFailed(event, ctx)];
    case "model_attempt_completed":
      return [onModelAttemptCompleted(event, ctx)];
    case "first_token":
      return [onFirstToken(event, ctx)];
    case "output_delta":
      return [onOutputDelta(event, ctx)];
    case "output_file_ref":
      return [onOutputFileRef(event, ctx)];
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
  boundary_message_id?: string;
} {
  return {
    session_id: ctx.sessionId,
    run_id: ctx.runId,
    call_id: ctx.rootCallId,
    agent_id: ctx.agentId,
    ...(ctx.boundaryMessageId ? { boundary_message_id: ctx.boundaryMessageId } : {}),
  };
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

function modelAttemptPayload(
  event: ModelAttemptStartedEvent | ModelAttemptFailedEvent | ModelAttemptCompletedEvent,
  ctx: WireTranslationContext,
) {
  return {
    attempt_id: event.attemptId,
    attempt: event.attempt,
    max_attempts: event.maxAttempts,
    round: event.round,
    provider: event.provider,
    model: event.model,
    ...streamLineage(ctx),
  };
}

function onModelAttemptStarted(event: ModelAttemptStartedEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "model_attempt_started",
    ...topMarkers(ctx),
    payload: { phase: "start", ...modelAttemptPayload(event, ctx) } satisfies ModelAttemptStartedPayload,
  };
}

function onModelAttemptFailed(event: ModelAttemptFailedEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "model_attempt_failed",
    ...topMarkers(ctx),
    payload: {
      phase: "failed",
      ...modelAttemptPayload(event, ctx),
      will_retry: event.willRetry,
      ...(event.retryDelayMs !== undefined ? { retry_delay_ms: event.retryDelayMs } : {}),
      elapsed_ms: event.elapsedMs,
      error: event.error,
    } satisfies ModelAttemptFailedPayload,
  };
}

function onModelAttemptCompleted(event: ModelAttemptCompletedEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "model_attempt_completed",
    ...topMarkers(ctx),
    payload: {
      phase: "end",
      ...modelAttemptPayload(event, ctx),
      elapsed_ms: event.elapsedMs,
    } satisfies ModelAttemptCompletedPayload,
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
    payload: { phase: "delta", content: event.content, part_index: event.partIndex, ...streamLineage(ctx) } satisfies StreamOutputPayload,
  };
}

function onOutputFileRef(event: OutputFileRefEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "stream_output",
    ...topMarkers(ctx),
    payload: {
      phase: "part_added",
      part_index: event.partIndex,
      part: {
        type: "file_ref",
        file_path: event.part.filePath,
        presentation: event.part.presentation,
        ...(event.part.caption ? { caption: event.part.caption } : {}),
      },
      ...streamLineage(ctx),
    } satisfies StreamOutputPayload,
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
  const agentOperation = translateAgentOperation(event.metadata.agent_operation);
  if (agentOperation) base.agent_operation = agentOperation;
  const files = translateToolFiles(event.referenceResult.files);
  if (files.length > 0) base.files = files;
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

function translateAgentOperation(value: unknown): ToolResultPayload["agent_operation"] {
  if (!isRecord(value)) return undefined;
  const type = asString(value.type);
  if (type !== "create_child" && type !== "resume_child" && type !== "message_child" && type !== "message_parent") {
    return undefined;
  }
  const messageKind = asString(value.message_kind);
  return {
    type,
    ...(asString(value.agent_name) ? { agent_name: asString(value.agent_name)! } : {}),
    ...(asString(value.child_agent_id) ? { child_agent_id: asString(value.child_agent_id)! } : {}),
    ...(asString(value.run_id) ? { run_id: asString(value.run_id)! } : {}),
    ...(asString(value.background_task_id) ? { background_task_id: asString(value.background_task_id)! } : {}),
    ...(asString(value.message_id) ? { message_id: asString(value.message_id)! } : {}),
    ...(messageKind === "progress" || messageKind === "request" || messageKind === "response" || messageKind === "result"
      ? { message_kind: messageKind }
      : {}),
    ...(value.delivery_status === "queued" ? { delivery_status: "queued" } : {}),
  };
}

function translateToolFiles(value: unknown): NonNullable<ToolResultPayload["files"]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const fileType = asString(item.fileType);
    const path = asString(item.path);
    const mediaType = asString(item.mimeType);
    const size = typeof item.size === "number" && Number.isInteger(item.size) && item.size >= 0
      ? item.size
      : null;
    if ((fileType !== "json" && fileType !== "text" && fileType !== "image") || !path || !mediaType || size === null) {
      return [];
    }
    return [{
      file_type: fileType,
      path,
      media_type: mediaType,
      size,
      metadata: isRecord(item.metadata) ? item.metadata : {},
    }];
  });
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
      token_source: event.source ?? "estimate",
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
