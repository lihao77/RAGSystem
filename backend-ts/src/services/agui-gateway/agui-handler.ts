import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { UserId } from "../../identity/types.js";

import type { RuntimeContainer } from "../../contracts/runtime-container.js";
import type { ExecutionApplication } from "../../contracts/execution-application.js";
import type { InteractionRecoveryApplication } from "../../contracts/interaction-recovery-application.js";
import { AguiTranslator } from "./agui-translator.js";
import { InterruptMachine, type InterruptRecord } from "./interrupt-machine.js";
import { openAguiSse, type AguiSseStream } from "./sse-stream.js";
import { lastUserTask, mapClientTools, type AguiResumeItem, type RunAgentInput } from "./agui-input.js";
import { encodeAguiSse, type AguiEvent } from "./agui-events.js";

type Rec = Record<string, unknown>;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const now = (): number => Date.now();
const baseFields = (threadId: string, runId: string) => ({ threadId, runId, timestamp: now() });

/**
 * AG-UI 适配网关：把内部 agent-protocol 事件流翻译成 AG-UI SSE，直连 container service。
 *
 * 内部协议/SDK 零改动。对外收 RunAgentInput，下行 SSE 流 AG-UI 事件。委托(client tool)/审批
 * (interrupt)经 run 折叠：内部连续 run 在 AG-UI 外部按 interrupt 边界分段，client resume 唤醒
 * 同一 internalRunId 继续。事件流由 subscribe 回调异步驱动；hijack 后 raw 由回调管理，handler 返回。
 */
export class AguiGateway {
  private readonly interruptMachine = new InterruptMachine();

  constructor(
    private readonly container: RuntimeContainer,
    private readonly userId: UserId,
    private readonly execution: ExecutionApplication,
    private readonly interactions: InteractionRecoveryApplication,
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

    if (input.resume && input.resume.length > 0) {
      this.handleResume(input, threadId, externalRunId, sse);
    } else {
      await this.handleNewRun(input, threadId, externalRunId, sse);
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

    const unsubscribe = this.container.realtimeEvents.subscribe(threadId, (env) => {
      if (done || internalRunId === null || translator === null) {
        return;
      }
      if (env.run_id !== internalRunId) {
        return;
      }
      const result = translator.translate(env);
      for (const aguiEvent of result.events) {
        send(aguiEvent);
      }
      if (result.interruptRecord) {
        this.interruptMachine.record(result.interruptRecord);
      }
      if (result.done) {
        done = true;
        unsubscribe();
        sse.end();
      }
    });
    sse.onClose(() => {
      done = true;
      unsubscribe();
    });

    const started = await this.execution.startStream(
      { task, session_id: threadId, userId: this.userId, attachments: [] },
      externalRunId,
    );
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
    // 此后事件流由 subscribe 回调异步驱动至 interrupt/terminal。
  }

  /** resume 段：唤醒内部 run（同一 internalRunId），synthesize ToolCallResult（delegate），继续流出。 */
  private handleResume(
    input: RunAgentInput,
    threadId: string,
    externalRunId: string,
    sse: AguiSseStream,
  ): void {
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
    const record = this.interruptMachine.take(item.interruptId);
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

    const unsubscribe = this.container.realtimeEvents.subscribe(threadId, (env) => {
      if (done) {
        return;
      }
      if (env.run_id !== internalRunId) {
        return;
      }
      const result = translator.translate(env);
      for (const aguiEvent of result.events) {
        send(aguiEvent);
      }
      if (result.interruptRecord) {
        this.interruptMachine.record(result.interruptRecord);
      }
      if (result.done) {
        done = true;
        unsubscribe();
        sse.end();
      }
    });
    sse.onClose(() => {
      done = true;
      unsubscribe();
    });

    // resume 段是新 AG-UI run。
    send({ type: "RUN_STARTED", ...baseFields(threadId, externalRunId) });

    // delegate：resume 后 synthesize ToolCallResult（AG-UI tool-bound interrupt 契约：不重发 ToolCallStart）。
    if (record.kind === "delegate") {
      const payload = item.status === "resolved" && item.payload && typeof item.payload === "object" ? (item.payload as Rec) : {};
      const ok = item.status === "resolved" && payload.ok !== false;
      const content = ok ? (str(payload.observation) ?? "") : (str(payload.error) ?? "tool failed");
      send({ type: "TOOL_CALL_RESULT", ...baseFields(threadId, externalRunId), messageId: randomUUID(), toolCallId: record.callId, content, role: "tool" });
    }

    // 唤醒内部 run（subscribe 已注册，resolve/respond 后续事件能收到——必须早于 resolve 的时序已满足）。
    this.applyResume(record, item);
  }

  /** 按 interrupt kind 把 resume 翻译成内部 resolve/respond；cancelled 视为拒绝以唤醒 run（不挂死）。 */
  private async applyResume(record: InterruptRecord, item: AguiResumeItem): Promise<void> {
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
      this.container.delegationPending.resolve(callId, resolution);
      return;
    }
    if (record.kind === "approval") {
      const resolution = {
        approved: resolved && payload.approved === true,
        message: str(payload.message) ?? "",
      };
      const result = await this.interactions.respondApproval(sessionId, callId, resolution);
      if (result.needsResume) {
        this.execution.resumeRun({ sessionId, approvalId: callId, resolution });
      }
      return;
    }
    // user_input
    const resolution = {
      value: resolved ? (str(payload.value) ?? "") : "",
    };
    const result = await this.interactions.respondUserInput(sessionId, callId, resolution);
    if (result.needsResume) {
      this.execution.resumeRun({ sessionId, approvalId: callId, resolution });
    }
  }
}
