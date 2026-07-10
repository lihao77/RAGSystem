/**
 * 内核线事件 → 线协议 Envelope 翻译（纯函数，零 IO）。
 *
 * 设计稿 §6 原则 4：内核产 KernelWireEvent（透传），消费端翻译成 Envelope。
 * 本函数是唯一翻译点，居 agent-protocol 协议面——翻译契约与两端类型同居底座。
 *
 * 纯函数：只依据 event + ctx 构造 Envelope[]，不碰 DB / outbox / WS。归档与推流由宿主
 * （backend-ts）拿本函数返回的 Envelope[] 统一完成；message/run 状态另由 backend persister 维护。
 *
 * 映射分流（对齐旧 backend-ts publishRuntimeEvent 的产 Envelope 分支）：
 *   - first_token / output_delta / intent_delta → stream_output
 *   - intent_complete → stream_output(intent_complete)（不产 message_saved；最终 message_saved 由 run 终态另发）
 *   - tool_call / tool_result → tool_call / tool_result（投影通知，固定 phase=start/end；委托执行走独立 delegate_call，不经此翻译）
 *   - error → error envelope
 *   - context_usage → state_sync(context_usage)
 *   - assistant_intermediate → []（纯落库事件，已由 Dispatcher 独占，无实时 Envelope）
 */
import type {
  ContextUsageEvent,
  IntentCompleteEvent,
  KernelWireEvent,
  OutputDeltaEvent,
  RuntimeErrorEvent,
  ToolCallEvent,
  ToolResultEvent,
  WireTranslationContext,
  IntentDeltaEvent,
  FirstTokenEvent,
} from "./kernel-events.js";
import type {
  Envelope,
  StateSyncPayload,
  StreamOutputPayload,
  ToolCallPayload,
  ToolResultPayload,
} from "./protocol.js";

/** 把单条 KernelWireEvent 翻译成 0~1 条 Envelope。 */
export function translateKernelEvent(event: KernelWireEvent, ctx: WireTranslationContext): Envelope[] {
  switch (event.type) {
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
      // 纯落库事件：SDK Dispatcher 已独占写 message，翻译层不产实时 Envelope。
      return [];
    default: {
      // 穷尽性守卫：新增事件类型时编译报错，强制补全翻译。
      const _exhaustive: never = event;
      void _exhaustive;
      return [];
    }
  }
}

/** 顶层 marker：run_id/agent_id/call_id（stream_output/error/state_sync 帧顶层用）。 */
function topMarkers(ctx: WireTranslationContext): {
  session_id: string;
  run_id: string;
  call_id: string;
  agent_id: string;
} {
  return { session_id: ctx.sessionId, run_id: ctx.runId, call_id: ctx.rootCallId, agent_id: ctx.agentId };
}

/** 工具 lineage：固定取 rootCallId（工具挂在当前 agent 的 root call 下，非 parentCallId）。 */
function toolLineage(ctx: WireTranslationContext): { parent_call_id?: string } {
  return { parent_call_id: ctx.rootCallId };
}

function onFirstToken(event: FirstTokenEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "stream_output",
    ...topMarkers(ctx),
    payload: { phase: "first_token", elapsed_ms: event.elapsedMs } satisfies StreamOutputPayload,
  };
}

function onOutputDelta(event: OutputDeltaEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "stream_output",
    ...topMarkers(ctx),
    payload: { phase: "delta", content: event.content } satisfies StreamOutputPayload,
  };
}

function onIntentDelta(event: IntentDeltaEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "stream_output",
    ...topMarkers(ctx),
    payload: { phase: "intent_delta", content: event.content, round: event.round } satisfies StreamOutputPayload,
  };
}

function onIntentComplete(event: IntentCompleteEvent, ctx: WireTranslationContext): Envelope {
  return {
    type: "stream_output",
    ...topMarkers(ctx),
    payload: { phase: "intent_complete", content: event.content, round: event.round } satisfies StreamOutputPayload,
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
