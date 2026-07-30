import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { UserId } from "../../identity/types.js";

import type { RuntimeContainer } from "../../contracts/runtime/runtime-container.js";
import type { ExecutionApplication } from "../../contracts/execution/execution-application.js";
import type { ExecutionReadApplication } from "../../contracts/execution/execution-read-application.js";
import type {
  ApprovalMeta,
  InteractionCoordinator,
  PendingInteractionRespondResult,
} from "../../contracts/runtime/pending-interactions.js";
import { AguiTranslator } from "./agui-translator.js";
import { InterruptMachine, type InterruptRecord } from "./interrupt-machine.js";
import { openAguiSse, type AguiSseStream } from "./sse-stream.js";
import { lastUserTask, mapClientTools, type AguiResumeItem, type RunAgentInput } from "./agui-input.js";
import { encodeAguiSse, type AguiEvent, type AguiInterrupt } from "./agui-events.js";
import type { Envelope, SessionRuntimePayload } from "../../contracts/events.js";
import { loadAguiRunReplay } from "./agui-replay.js";

type Rec = Record<string, unknown>;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const now = (): number => Date.now();
const baseFields = (threadId: string, runId: string) => ({ threadId, runId, timestamp: now() });

function pendingInterruptRecord(meta: ApprovalMeta, threadId: string, internalRunId: string): InterruptRecord {
  // The runtime interaction id is durable and can be used directly by a
  // later AG-UI resume request after the original SSE stream is gone.
  const aguiInterruptId = meta.approvalId;
  const approval = meta.kind === "approval";
  const interrupt: AguiInterrupt = approval
    ? {
        id: aguiInterruptId,
        reason: "confirmation",
        toolCallId: meta.toolCallId,
        message: meta.prompt || meta.reason || "需要确认",
        responseSchema: {
          type: "object",
          properties: { approved: { type: "boolean" }, message: { type: "string" } },
          required: ["approved"],
        },
      }
    : {
        id: aguiInterruptId,
        reason: "input_required",
        message: meta.prompt || "请提供输入",
        responseSchema: {
          type: "object",
          properties: {
            value: meta.options?.length
              ? { type: "string", enum: meta.options }
              : { type: "string" },
          },
          required: ["value"],
        },
      };
  return {
    threadId,
    aguiInterruptId,
    callId: meta.approvalId,
    kind: approval ? "approval" : "user_input",
    internalRunId,
    ...(approval ? { toolCallId: meta.toolCallId } : {}),
    ...(meta.toolName ? { toolName: meta.toolName } : {}),
    interrupt,
  };
}

function compareEnvelopeSeq(left: Envelope, right: Envelope): number {
  const leftSeq = typeof left.seq === "number" ? left.seq : Number.MAX_SAFE_INTEGER;
  const rightSeq = typeof right.seq === "number" ? right.seq : Number.MAX_SAFE_INTEGER;
  return leftSeq - rightSeq;
}

function runtimeInterruptRecord(
  interaction: SessionRuntimePayload["pending_interactions"][number],
  threadId: string,
  internalRunId: string,
): InterruptRecord {
  const payload = interaction.payload && typeof interaction.payload === "object" && !Array.isArray(interaction.payload)
    ? interaction.payload as Rec
    : {};
  const input = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
    ? payload.input as Rec
    : {};
  const callId = interaction.interaction_id;
  const approval = interaction.kind === "approval";
  const toolCallId = str(input.tool_call_id);
  const toolName = str(payload.tool);
  const prompt = str(payload.prompt) || str(payload.message);
  const options = Array.isArray(input.options) ? input.options.filter((item): item is string => typeof item === "string") : [];
  const interrupt: AguiInterrupt = approval
    ? {
        id: callId,
        reason: "confirmation",
        ...(toolCallId ? { toolCallId } : {}),
        message: prompt || "需要确认",
        responseSchema: {
          type: "object",
          properties: { approved: { type: "boolean" }, message: { type: "string" } },
          required: ["approved"],
        },
      }
    : {
        id: callId,
        reason: "input_required",
        message: prompt || "请提供输入",
        responseSchema: {
          type: "object",
          properties: { value: options.length ? { type: "string", enum: options } : { type: "string" } },
          required: ["value"],
        },
      };
  return {
    threadId,
    aguiInterruptId: callId,
    callId,
    kind: approval ? "approval" : "user_input",
    internalRunId,
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    interrupt,
  };
}

/**
 * AG-UI 适配网关：把内部 agent-protocol 事件流翻译成 AG-UI SSE，直连 container service。
 *
 * 内部协议/SDK 零改动。对外收 RunAgentInput，下行 SSE 流 AG-UI 事件。委托(client tool)/审批
 * (interrupt)经 run 折叠：内部连续 run 在 AG-UI 外部按 interrupt 边界分段，client resume 唤醒
 * 同一 internalRunId 继续。事件流由 subscribe 回调异步驱动；hijack 后 raw 由回调管理，handler 返回。
 */
export class AguiGateway {
  constructor(
    private readonly container: RuntimeContainer,
    private readonly userId: UserId,
    private readonly execution: ExecutionApplication,
    private readonly executionRead: ExecutionReadApplication,
    private readonly interactions: InteractionCoordinator,
    private readonly interruptMachine = new InterruptMachine(),
  ) {}

  async handle(input: RunAgentInput, reply: FastifyReply): Promise<void> {
    const threadId = input.threadId ?? randomUUID();
    const externalRunId = input.runId ?? randomUUID();

    // 上行 client tools：覆盖式注册到 session 级 hostToolRegistry。
    const tools = mapClientTools(input.tools);
    if (tools.length > 0) {
      this.container.hostToolRegistry.register(threadId, tools);
    }

    const sse = openAguiSse(reply);

    if (input.reconnect) {
      await this.handleReconnect(input, threadId, externalRunId, sse);
    } else if (input.resume && input.resume.length > 0) {
      await this.handleResume(input, threadId, externalRunId, sse);
    } else {
      await this.handleNewRun(input, threadId, externalRunId, sse);
    }
  }

  /** Reconnect segment: replay one active run, then merge into its live event stream. */
  private async handleReconnect(
    input: RunAgentInput,
    threadId: string,
    externalRunId: string,
    sse: AguiSseStream,
  ): Promise<void> {
    const reconnect = input.reconnect;
    const send = (event: AguiEvent): void => sse.send(encodeAguiSse(event));
    if (!reconnect?.runId) {
      send({ type: "RUN_STARTED", ...baseFields(threadId, externalRunId) });
      send({ type: "RUN_ERROR", ...baseFields(threadId, externalRunId), message: "reconnect 缺少 active run_id" });
      sse.end();
      return;
    }

    const internalRunId = reconnect.runId;
    const translator = new AguiTranslator({
      threadId,
      externalRunId,
      internalRunId,
      genInterruptId: () => randomUUID(),
    });
    let done = false;
    let replaying = true;
    let lastSeq = reconnect.afterSeq ?? 0;
    const buffered: Envelope[] = [];

    const finish = (): void => {
      if (done) return;
      done = true;
      unsubscribe();
      sse.end();
    };
    const processEnvelope = (env: Envelope): void => {
      if (done || env.run_id !== internalRunId) return;
      if (typeof env.seq === "number") {
        if (env.seq <= lastSeq) return;
        lastSeq = env.seq;
      }
      const result = translator.translate(env);
      if (result.interruptRecord) this.interruptMachine.record(result.interruptRecord);
      for (const event of result.events) {
        if (event.type === "RUN_STARTED") continue;
        send(event);
      }
      if (result.done) finish();
    };
    const unsubscribe = this.container.realtimeEvents.subscribe(threadId, (env) => {
      if (done || env.run_id !== internalRunId) return;
      if (replaying) {
        buffered.push(env);
        return;
      }
      processEnvelope(env);
    });
    sse.onClose(() => {
      if (done) return;
      done = true;
      unsubscribe();
    });

    send({ type: "RUN_STARTED", ...baseFields(threadId, externalRunId) });
    try {
      const initialRuntime = await this.container.sessionRuntime.getSnapshot(threadId);
      const initialPending = initialRuntime.pending_interactions[0];
      if (initialPending) {
        const record = runtimeInterruptRecord(initialPending, threadId, initialRuntime.active_run?.run_id ?? internalRunId);
        this.interruptMachine.record(record);
        send({
          type: "RUN_FINISHED",
          ...baseFields(threadId, externalRunId),
          outcome: { type: "interrupt", interrupts: [record.interrupt] },
        });
        finish();
        return;
      }
      if (!initialRuntime.active_run || initialRuntime.active_run.run_id !== internalRunId) {
        send({ type: "RUN_ERROR", ...baseFields(threadId, externalRunId), message: "active run 已结束或发生变化" });
        finish();
        return;
      }

      const replay = await loadAguiRunReplay(this.executionRead, threadId, internalRunId, lastSeq);
      for (const env of replay) {
        processEnvelope(env);
        if (done) return;
      }
      buffered.sort(compareEnvelopeSeq).forEach(processEnvelope);
      buffered.length = 0;
      replaying = false;
      if (done) return;

      const currentRuntime = await this.container.sessionRuntime.getSnapshot(threadId);
      if (done) return;
      const pending = currentRuntime.pending_interactions[0];
      if (pending) {
        const record = runtimeInterruptRecord(pending, threadId, currentRuntime.active_run?.run_id ?? internalRunId);
        this.interruptMachine.record(record);
        send({
          type: "RUN_FINISHED",
          ...baseFields(threadId, externalRunId),
          outcome: { type: "interrupt", interrupts: [record.interrupt] },
        });
        finish();
        return;
      }
      if (!currentRuntime.active_run || currentRuntime.active_run.run_id !== internalRunId) {
        const tail = await loadAguiRunReplay(this.executionRead, threadId, internalRunId, lastSeq);
        for (const env of tail) {
          processEnvelope(env);
          if (done) return;
        }
        send({ type: "RUN_FINISHED", ...baseFields(threadId, externalRunId), outcome: { type: "success" } });
        finish();
      }
    } catch (error) {
      if (done) return;
      send({
        type: "RUN_ERROR",
        ...baseFields(threadId, externalRunId),
        message: error instanceof Error ? error.message : "active run 重连失败",
      });
      finish();
    }
  }

  /** 新 run：subscribe → startStream → 翻译流出至 interrupt 边界或 run 终态。 */
  private async handleNewRun(
    input: RunAgentInput,
    threadId: string,
    externalRunId: string,
    sse: AguiSseStream,
  ): Promise<void> {
    const task = lastUserTask(input.messages);
    const send = (e: AguiEvent): void => {
      sse.send(encodeAguiSse(e));
    };
    if (!task) {
      send({ type: "RUN_STARTED", ...baseFields(threadId, externalRunId) });
      send({ type: "RUN_ERROR", ...baseFields(threadId, externalRunId), message: "messages 缺少 user 消息" });
      sse.end();
      return;
    }

    let internalRunId: string | null = null;
    let translator: AguiTranslator | null = null;
    let done = false;
    let startedSent = false;
    const buffered: Envelope[] = [];

    const processEnvelope = (env: Envelope): void => {
      if (done || internalRunId === null || translator === null || env.run_id !== internalRunId) return;
      const result = translator.translate(env);
      // Register before writing RUN_FINISHED{interrupt}. A fast client may
      // submit resume as soon as the frame is received.
      if (result.interruptRecord) this.interruptMachine.record(result.interruptRecord);
      for (const aguiEvent of result.events) {
        if (aguiEvent.type === "RUN_STARTED" && startedSent) continue;
        if (aguiEvent.type === "RUN_STARTED") startedSent = true;
        send(aguiEvent);
      }
      if (result.done) {
        done = true;
        unsubscribe();
        sse.end();
      }
    };

    const unsubscribe = this.container.realtimeEvents.subscribe(threadId, (env) => {
      if (done) return;
      if (internalRunId === null || translator === null) {
        buffered.push(env);
        return;
      }
      processEnvelope(env);
    });
    sse.onClose(() => {
      if (done) return;
      done = true;
      unsubscribe();
    });

    const started = await this.execution.startStream(
      { task, session_id: threadId, userId: this.userId, attachments: input.attachments ?? [] },
      externalRunId,
      { followupPolicy: "reject" },
    );
    if (started.kind === "command") {
      const command = started.command_result;
      send({ type: "RUN_STARTED", ...baseFields(threadId, externalRunId) });
      if (command?.content) {
        const messageId = randomUUID();
        send({ type: "TEXT_MESSAGE_START", ...baseFields(threadId, externalRunId), messageId, role: "assistant" });
        send({ type: "TEXT_MESSAGE_CONTENT", ...baseFields(threadId, externalRunId), messageId, delta: command.content });
        send({ type: "TEXT_MESSAGE_END", ...baseFields(threadId, externalRunId), messageId });
      }
      if (command?.success ?? started.started) {
        send({ type: "RUN_FINISHED", ...baseFields(threadId, externalRunId), outcome: { type: "success" } });
      } else {
        send({ type: "RUN_ERROR", ...baseFields(threadId, externalRunId), message: command?.content || started.error || "command failed" });
      }
      done = true;
      unsubscribe();
      sse.end();
      return;
    }
    if (!started.started || !started.run_id) {
      unsubscribe();
      send({ type: "RUN_STARTED", ...baseFields(threadId, externalRunId) });
      send({ type: "RUN_ERROR", ...baseFields(threadId, externalRunId), message: started.error ?? "run 未启动" });
      sse.end();
      return;
    }
    internalRunId = started.run_id;
    translator = new AguiTranslator({
      threadId,
      externalRunId,
      internalRunId,
      genInterruptId: () => randomUUID(),
    });
    if (!done) {
      send({ type: "RUN_STARTED", ...baseFields(threadId, externalRunId) });
      startedSent = true;
      for (const env of buffered.splice(0)) processEnvelope(env);
    }
    // 此后事件流由 subscribe 回调异步驱动至 interrupt/terminal。
  }

  /** resume 段：唤醒内部 run（同一 internalRunId），synthesize ToolCallResult（delegate），继续流出。 */
  private async handleResume(
    input: RunAgentInput,
    threadId: string,
    externalRunId: string,
    sse: AguiSseStream,
  ): Promise<void> {
    const item = input.resume?.[0];
    const send = (e: AguiEvent): void => {
      sse.send(encodeAguiSse(e));
    };
    if (!item) {
      send({ type: "RUN_STARTED", ...baseFields(threadId, externalRunId) });
      send({ type: "RUN_ERROR", ...baseFields(threadId, externalRunId), message: "resume 缺少 interrupt 项" });
      sse.end();
      return;
    }
    const pendingRecord = this.interruptMachine.peek(item.interruptId);
    if (pendingRecord && pendingRecord.threadId !== threadId) {
      send({ type: "RUN_STARTED", ...baseFields(threadId, externalRunId) });
      send({ type: "RUN_ERROR", ...baseFields(threadId, externalRunId), message: `interrupt ${item.interruptId} 不属于当前 thread` });
      sse.end();
      return;
    }
    let record = this.interruptMachine.take(item.interruptId);
    if (!record) {
      // The SSE stream may have been interrupted after the durable runtime
      // interaction was recorded but before the in-memory gateway record was
      // retained. Reconstruct the AG-UI wrapper from the pending interaction.
      const meta = this.interactions.peekApprovalMeta(item.interruptId, threadId);
      if (meta && !meta.resolved) {
        record = pendingInterruptRecord(meta, threadId, meta.runId);
      }
    }
    if (!record) {
      const runtime = await this.container.sessionRuntime.getSnapshot(threadId);
      const pending = runtime.pending_interactions.find((interaction) => interaction.interaction_id === item.interruptId);
      if (pending) {
        record = runtimeInterruptRecord(pending, threadId, runtime.active_run?.run_id ?? pending.run_id);
      }
    }
    if (!record) {
      send({ type: "RUN_STARTED", ...baseFields(threadId, externalRunId) });
      send({ type: "RUN_ERROR", ...baseFields(threadId, externalRunId), message: `interrupt ${item.interruptId} 已失效或不存在` });
      sse.end();
      return;
    }

    const internalRunId = record.internalRunId;
    const translator = new AguiTranslator({
      threadId,
      externalRunId,
      internalRunId,
      genInterruptId: () => randomUUID(),
    });
    let done = false;
    let resumeAccepted = false;
    const buffered: Envelope[] = [];

    const processEnvelope = (env: Envelope): void => {
      if (done || env.run_id !== internalRunId) return;
      const result = translator.translate(env);
      if (result.interruptRecord) this.interruptMachine.record(result.interruptRecord);
      for (const aguiEvent of result.events) send(aguiEvent);
      if (result.done) {
        done = true;
        unsubscribe();
        sse.end();
      }
    };

    const unsubscribe = this.container.realtimeEvents.subscribe(threadId, (env) => {
      if (done || env.run_id !== internalRunId) return;
      if (!resumeAccepted) {
        buffered.push(env);
        return;
      }
      processEnvelope(env);
    });
    sse.onClose(() => {
      if (done) return;
      done = true;
      unsubscribe();
    });

    let respondResult: PendingInteractionRespondResult | null = null;
    try {
      // subscribe 必须早于 resolve/respond，避免恢复时同步发出的内部事件丢失。
      respondResult = await this.applyResume(record, item);
    } catch (error) {
      this.interruptMachine.record(record);
      done = true;
      unsubscribe();
      send({ type: "RUN_STARTED", ...baseFields(threadId, externalRunId) });
      send({
        type: "RUN_ERROR",
        ...baseFields(threadId, externalRunId),
        message: error instanceof Error ? error.message : "interrupt 恢复失败",
      });
      sse.end();
      return;
    }

    if (done) return;
    resumeAccepted = true;
    send({ type: "RUN_STARTED", ...baseFields(threadId, externalRunId) });
    send({
      type: "CUSTOM",
      ...baseFields(threadId, externalRunId),
      name: "interrupt.resolved",
      value: { interruptId: item.interruptId, status: item.status },
    });

    // delegate：resume 后 synthesize ToolCallResult（AG-UI tool-bound interrupt 契约：不重发 ToolCallStart）。
    if (record.kind === "delegate") {
      const payload = item.status === "resolved" && item.payload && typeof item.payload === "object" ? (item.payload as Rec) : {};
      const ok = item.status === "resolved" && payload.ok !== false;
      const content = ok ? (str(payload.observation) ?? "") : (str(payload.error) ?? "tool failed");
      send({ type: "TOOL_CALL_RESULT", ...baseFields(threadId, externalRunId), messageId: randomUUID(), toolCallId: record.callId, content, role: "tool" });
    }

    for (const env of buffered.splice(0)) {
      processEnvelope(env);
      if (done) break;
    }
    if (done || respondResult?.needsResume !== false || !respondResult.rootRunId) return;

    try {
      const pending = await this.interactions.listPendingAsync(respondResult.rootRunId, threadId);
      const next = pending.find((meta) => !meta.resolved && meta.approvalId !== record.callId);
      if (!next) return;
      const nextRecord = pendingInterruptRecord(next, threadId, internalRunId);
      this.interruptMachine.record(nextRecord);
      send({
        type: "RUN_FINISHED",
        ...baseFields(threadId, externalRunId),
        outcome: { type: "interrupt", interrupts: [nextRecord.interrupt] },
      });
      done = true;
      unsubscribe();
      sse.end();
    } catch (error) {
      done = true;
      unsubscribe();
      send({
        type: "RUN_ERROR",
        ...baseFields(threadId, externalRunId),
        message: error instanceof Error ? error.message : "读取后续审批失败",
      });
      sse.end();
    }
  }

  /** 按 interrupt kind 把 resume 翻译成内部 resolve/respond；cancelled 视为拒绝以唤醒 run（不挂死）。 */
  private async applyResume(record: InterruptRecord, item: AguiResumeItem): Promise<PendingInteractionRespondResult | null> {
    const sessionId = record.threadId;
    const callId = record.callId;
    const resolved = item.status === "resolved";
    const payload = resolved && item.payload && typeof item.payload === "object" ? (item.payload as Rec) : {};

    if (record.kind === "delegate") {
      const ok = resolved && payload.ok !== false;
      const observation = str(payload.observation);
      const resolution: { ok: boolean; observation?: string; error?: string } = { ok };
      if (observation) {
        resolution.observation = observation;
      }
      if (!ok) {
        resolution.error = str(payload.error) ?? "cancelled";
      }
      const resolvedPending = this.container.delegationPending.resolve(callId, resolution);
      if (!resolvedPending) {
        throw new Error(`委托工具 ${callId} 已失效或等待已超时`);
      }
      return null;
    }
    if (record.kind === "approval") {
      const resolution = {
        approved: resolved && payload.approved === true,
        message: str(payload.message) ?? "",
      };
      const result = await this.interactions.respondApprovalAsync(sessionId, callId, resolution);
      if (!result.resolved) throw new Error("审批请求已失效或不存在");
      return result;
    }
    // user_input
    const resolution = {
      value: resolved ? (str(payload.value) ?? "") : "",
    };
    const result = await this.interactions.respondUserInputAsync(sessionId, callId, resolution);
    if (!result.resolved) throw new Error("输入请求已失效或不存在");
    return result;
  }
}
