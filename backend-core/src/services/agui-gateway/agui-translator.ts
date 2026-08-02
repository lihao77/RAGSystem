import { randomUUID } from "node:crypto";

import type { Envelope } from "../../contracts/events.js";
import type {
  AguiEvent,
  AguiInterrupt,
  CustomEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  StepFinishedEvent,
  StepStartedEvent,
  ToolCallResultEvent,
} from "./agui-events.js";
import type { InterruptRecord } from "./interrupt-machine.js";

export interface TranslateContext {
  threadId: string;
  /** AG-UI 客户端提供的 runId（事件流出用它）。 */
  externalRunId: string;
  /** 内部 run_id（仅供 handler subscribe 过滤；不进 AG-UI 事件）。 */
  internalRunId: string;
  /** 生成 AG-UI interrupt.id（resume 引用键）。 */
  genInterruptId: () => string;
}

export interface TranslateResult {
  events: AguiEvent[];
  /** interrupt 边界：handler 应 record 并结束本次 SSE（events 已含 RUN_FINISHED{interrupt}）。 */
  interruptRecord?: InterruptRecord;
  /** 本次 SSE 应结束（interrupt 边界或 run 终态）。 */
  done?: boolean;
}

type Rec = Record<string, unknown>;
const payloadOf = (env: Envelope): Rec => (env.payload ?? {}) as Rec;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * 下行翻译器：内部 agent-protocol Envelope → AG-UI 事件。
 *
 * 每个 SSE 请求一个实例（维护文本/思考流的 messageId 状态）。runId 用 externalRunId
 * （客户端提供）；internalRunId 仅供 handler 做 subscribe 过滤，不进 AG-UI 事件。
 */
export class AguiTranslator {
  private textMessageId: string | null = null;
  private textHasStreamedContent = false;
  private reasoningMessageId: string | null = null;
  private eventSeq: number | undefined;

  constructor(private readonly ctx: TranslateContext) {}

  translate(env: Envelope): TranslateResult {
    this.eventSeq = typeof env.seq === "number" ? env.seq : undefined;
    switch (env.type) {
      case "run_started":
        return { events: [this.runStarted()] };
      case "run_ended":
        return this.runEnded(payloadOf(env));
      case "stream_output":
        return { events: this.streamOutput(payloadOf(env)) };
      case "tool_call":
        return { events: this.toolCall(env, payloadOf(env)) };
      case "tool_result":
        return { events: [this.toolResult(env, payloadOf(env))] };
      case "agent_started":
        return { events: [this.step(env, true)] };
      case "agent_ended":
        return { events: [this.step(env, false)] };
      case "model_request":
        return { events: [{ type: "CUSTOM", ...this.base(), name: "model_request", value: payloadOf(env) }] };
      case "state_sync":
        return { events: this.stateSync(payloadOf(env)) };
      case "delegate_call":
        return this.delegateCall(env, payloadOf(env));
      case "interaction":
        return this.interaction(env, payloadOf(env));
      case "error":
        return { events: [this.runError(str(payloadOf(env).message) ?? "agent error")], done: true };
      default:
        // heartbeat / ack / session.* / capability_manifest / user_driven_change / abort /
        // delegate_result(上行) / interaction(responded) —— 网关不投影。
        return { events: [] };
    }
  }

  private base(): { threadId: string; runId: string; timestamp: number; eventSeq?: number } {
    return {
      threadId: this.ctx.threadId,
      runId: this.ctx.externalRunId,
      timestamp: Date.now(),
      ...(this.eventSeq !== undefined ? { eventSeq: this.eventSeq } : {}),
    };
  }

  private runStarted(): RunStartedEvent {
    return { type: "RUN_STARTED", ...this.base() };
  }

  private runEnded(payload: Rec): TranslateResult {
    const status = str(payload.status);
    if (status === "completed") {
      return { events: [{ type: "RUN_FINISHED", ...this.base(), outcome: { type: "success" } }], done: true };
    }
    if (status === "suspended") {
      return { events: [] };
    }
    // failed / interrupted：interrupted 通常已由 delegate/interaction 提前翻成 interrupt，
    // 直收到视为异常终止。
    return { events: [this.runError(str(payload.reason) ?? "run ended")], done: true };
  }

  private runError(message: string): RunErrorEvent {
    return { type: "RUN_ERROR", ...this.base(), message };
  }

  private streamOutput(payload: Rec): AguiEvent[] {
    const phase = str(payload.phase);
    const content = str(payload.content) ?? "";
    if (phase === "intent_delta" || phase === "intent_complete") {
      return this.reasoningStream(phase, content);
    }
    const events: AguiEvent[] = [];
    if (phase === "first_token") {
      this.textMessageId = randomUUID();
      this.textHasStreamedContent = false;
      events.push({ type: "TEXT_MESSAGE_START", ...this.base(), messageId: this.textMessageId, role: "assistant" });
      if (content) {
        events.push(this.textContent(content));
        this.textHasStreamedContent = true;
      }
    } else if (phase === "delta") {
      if (this.textMessageId === null) {
        this.textMessageId = randomUUID();
        this.textHasStreamedContent = false;
        events.push({ type: "TEXT_MESSAGE_START", ...this.base(), messageId: this.textMessageId, role: "assistant" });
      }
      if (content) {
        events.push(this.textContent(content));
        this.textHasStreamedContent = true;
      }
    } else if (phase === "final") {
      if (this.textMessageId === null) {
        this.textMessageId = randomUUID();
        this.textHasStreamedContent = false;
        events.push({ type: "TEXT_MESSAGE_START", ...this.base(), messageId: this.textMessageId, role: "assistant" });
      }
      if (content && !this.textHasStreamedContent) {
        events.push(this.textContent(content));
      }
      events.push({ type: "TEXT_MESSAGE_END", ...this.base(), messageId: this.textMessageId });
      this.textMessageId = null;
      this.textHasStreamedContent = false;
    }
    return events;
  }

  private textContent(delta: string): AguiEvent {
    return { type: "TEXT_MESSAGE_CONTENT", ...this.base(), messageId: this.textMessageId ?? randomUUID(), delta };
  }

  private reasoningStream(phase: string, content: string): AguiEvent[] {
    const events: AguiEvent[] = [];
    if (this.reasoningMessageId === null) {
      this.reasoningMessageId = randomUUID();
      events.push({ type: "REASONING_MESSAGE_START", ...this.base(), messageId: this.reasoningMessageId });
    }
    if (phase === "intent_delta" && content) {
      events.push({ type: "REASONING_MESSAGE_CONTENT", ...this.base(), messageId: this.reasoningMessageId, delta: content });
    }
    if (phase === "intent_complete") {
      events.push({ type: "REASONING_MESSAGE_END", ...this.base(), messageId: this.reasoningMessageId });
      this.reasoningMessageId = null;
    }
    return events;
  }

  private toolCall(env: Envelope, payload: Rec): AguiEvent[] {
    const toolCallId = env.call_id ?? randomUUID();
    const toolName = str(payload.tool) ?? "tool";
    return [
      { type: "TOOL_CALL_START", ...this.base(), toolCallId, toolCallName: toolName },
      { type: "TOOL_CALL_ARGS", ...this.base(), toolCallId, delta: JSON.stringify(payload.input ?? {}) },
      { type: "TOOL_CALL_END", ...this.base(), toolCallId },
    ];
  }

  private toolResult(env: Envelope, payload: Rec): ToolCallResultEvent {
    const toolCallId = env.call_id ?? randomUUID();
    const content = str(payload.observation) ?? str(payload.summary) ?? "";
    return { type: "TOOL_CALL_RESULT", ...this.base(), messageId: randomUUID(), toolCallId, content, role: "tool" };
  }

  private step(env: Envelope, start: boolean): StepStartedEvent | StepFinishedEvent {
    const payload = payloadOf(env);
    const stepName = str(payload.display_name) ?? env.agent_id ?? "agent";
    return start
      ? { type: "STEP_STARTED", ...this.base(), stepName }
      : { type: "STEP_FINISHED", ...this.base(), stepName };
  }

  private stateSync(payload: Rec): AguiEvent[] {
    const category = str(payload.category);
    if (!category || category === "message_saved") {
      return []; // 内部消息持久化遥测，AG-UI 侧无需投影。
    }
    const value: Rec = {};
    if (payload.metrics !== undefined) value.metrics = payload.metrics;
    if (payload.detail !== undefined) value.detail = payload.detail;
    if (payload.ref !== undefined) value.ref = payload.ref;
    const event: CustomEvent = { type: "CUSTOM", ...this.base(), name: category, value };
    return [event];
  }

  private delegateCall(env: Envelope, payload: Rec): TranslateResult {
    const callId = env.call_id ?? randomUUID();
    const toolName = str(payload.tool) ?? "tool";
    const input = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
      ? payload.input as Rec
      : {};
    // Keep the external interrupt id stable across an SSE reconnect. The
    // internal call id is durable for the lifetime of the delegated request.
    const aguiInterruptId = callId;
    const interrupt: AguiInterrupt = {
      id: aguiInterruptId,
      reason: "tool_call",
      toolCallId: callId,
      message: `执行前端工具 ${toolName}`,
      metadata: { toolName, arguments: input },
      responseSchema: {
        type: "object",
        properties: { ok: { type: "boolean" }, observation: { type: "string" }, error: { type: "string" } },
        required: ["ok"],
      },
    };
    const events: AguiEvent[] = [
      { type: "TOOL_CALL_START", ...this.base(), toolCallId: callId, toolCallName: toolName },
      { type: "TOOL_CALL_ARGS", ...this.base(), toolCallId: callId, delta: JSON.stringify(input) },
      { type: "TOOL_CALL_END", ...this.base(), toolCallId: callId },
      { type: "RUN_FINISHED", ...this.base(), outcome: { type: "interrupt", interrupts: [interrupt] } },
    ];
    return {
      events,
      interruptRecord: {
        threadId: this.ctx.threadId,
        aguiInterruptId,
        callId,
        kind: "delegate",
        internalRunId: this.ctx.internalRunId,
        toolCallId: callId,
        toolName,
        interrupt,
      },
      done: true,
    };
  }

  private interaction(env: Envelope, payload: Rec): TranslateResult {
    if (str(payload.phase) !== "required") {
      return { events: [] }; // responded 由内部 resolve 后产生，网关不投影（resume 路径已处理）。
    }
    const callId = env.call_id ?? randomUUID();
    // Interaction ids are persisted by the runtime. Reusing the call id lets
    // a later AG-UI request recover an approval even if the first SSE stream
    // was interrupted before the client received RUN_FINISHED.
    const aguiInterruptId = callId;
    if (str(payload.kind) === "approval") {
      const toolName = str(payload.tool);
      const interrupt: AguiInterrupt = {
        id: aguiInterruptId,
        reason: "confirmation",
        toolCallId: callId,
        message: str(payload.prompt) || str(payload.message) || "需要确认",
        responseSchema: {
          type: "object",
          properties: { approved: { type: "boolean" }, message: { type: "string" } },
          required: ["approved"],
        },
      };
      return {
        events: [{ type: "RUN_FINISHED", ...this.base(), outcome: { type: "interrupt", interrupts: [interrupt] } }],
        interruptRecord: {
          threadId: this.ctx.threadId,
          aguiInterruptId,
          callId,
          kind: "approval",
          internalRunId: this.ctx.internalRunId,
          toolCallId: callId,
          ...(toolName ? { toolName } : {}),
          interrupt,
        },
        done: true,
      };
    }
    // user_input
    const inputInfo = (payload.input ?? {}) as Rec;
    const rawOptions = Array.isArray(inputInfo.options) ? (inputInfo.options as unknown[]) : [];
    const enumOptions = rawOptions.filter((o): o is string => typeof o === "string");
    const valueSchema: Rec = enumOptions.length ? { type: "string", enum: enumOptions } : { type: "string" };
    const interrupt: AguiInterrupt = {
      id: aguiInterruptId,
      reason: "input_required",
      message: str(payload.prompt) || "请提供输入",
      responseSchema: { type: "object", properties: { value: valueSchema }, required: ["value"] },
    };
    return {
      events: [{ type: "RUN_FINISHED", ...this.base(), outcome: { type: "interrupt", interrupts: [interrupt] } }],
      interruptRecord: {
        threadId: this.ctx.threadId,
        aguiInterruptId,
        callId,
        kind: "user_input",
        internalRunId: this.ctx.internalRunId,
        interrupt,
      },
      done: true,
    };
  }
}
