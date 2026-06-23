import type { Envelope } from "../../../contracts/events.js";
import type { MessageInfo } from "../../../contracts/session.js";
import type { ConversationStore, OutboxRow, RunStepRecord } from "../../../contracts/conversation-store/index.js";
import type { RunStepInfo } from "../../../contracts/common.js";
import { asString, isRecord } from "./helpers.js";

export type RunTerminalStatus = "completed" | "failed" | "interrupted";

/** 打断收口的悬空工具调用统一结果文案。 */
const INTERRUPTED_TOOL_SUMMARY = "工具执行被中断";
const INTERRUPTED_TOOL_OBSERVATION = "工具执行被中断";

export interface RunCompletedRecordInput {
  status: "completed";
  sessionId: string;
  runId: string;
  taskId: string;
  requestId: string;
  rootCallId: string;
  agentName: string;
  agentDisplayName: string;
  threadKey: string;
  childAgentId?: string | null;
  finalMessage: {
    id: string;
    content: string;
    metadata: Record<string, unknown>;
  };
  /** run_step 表（API 契约）的最终答案 step 与 run 结束 step；不进 WS 事件流。 */
  finalStepPayload: Record<string, unknown>;
  runEndStepPayload: Record<string, unknown>;
  finalMetadata: Record<string, unknown>;
}

export interface RunFailedRecordInput {
  status: "failed" | "interrupted";
  sessionId: string;
  runId: string;
  taskId: string;
  requestId: string;
  rootCallId: string;
  agentName: string;
  agentDisplayName: string;
  errorMessage: string;
  errorType: "ExecutionError" | "InterruptedError";
  agentResult: string;
  childAgentId?: string | null;
  threadKey: string;
  runEndStepPayload: Record<string, unknown>;
  finalMetadata: Record<string, unknown>;
}

/** 打断前「已 start 未 end」的悬空工具调用（收口补 tool_result 用）。 */
interface DanglingToolCall {
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  round: number;
  order: number;
  roundIndex: number;
  agentName: string;
  agentDisplayName: string;
}

export interface RunTerminalRecord {
  message: MessageInfo | null;
  steps: RunStepRecord[];
  outboxRows: OutboxRow[];
}

/**
 * run 终态落库：addMessage + addRunStep（API 契约，旧 execution.step 结构）+ appendOutbox（新 envelope）。
 *
 * outbox 产出新协议 envelope（stream_output(final) / state_sync(message_saved) / agent_ended / run_ended），
 * 与实时 event-publisher 走同一条 `client.{type}` 路径，projector 单分支还原。
 * child run 的 agent_ended 由 delegation publishAgentCallEnd 独占，此处 outbox 为空，仅落库 + run_step。
 */
export class ExecutionRecorder {
  constructor(private readonly conversationStore: ConversationStore) {}

  recordRunTerminal(input: RunCompletedRecordInput | RunFailedRecordInput): RunTerminalRecord {
    return input.status === "completed" ? this.recordCompleted(input) : this.recordFailed(input);
  }

  private recordCompleted(input: RunCompletedRecordInput): RunTerminalRecord {
    return this.conversationStore.runInTransaction((tx) => {
      const message = tx.addMessage({
        sessionId: input.sessionId,
        role: "assistant",
        content: input.finalMessage.content,
        metadata: input.finalMessage.metadata,
        messageId: input.finalMessage.id,
        threadKey: input.threadKey,
        childAgentId: input.childAgentId ?? null,
      });
      const finalStep = tx.addRunStep({
        sessionId: input.sessionId,
        runId: input.runId,
        stepType: "execution.step",
        payload: input.finalStepPayload,
      });
      const runEndStep = tx.addRunStep({
        sessionId: input.sessionId,
        runId: input.runId,
        stepType: "execution.step",
        payload: input.runEndStepPayload,
      });
      tx.updateRunStepsMessageId(input.sessionId, input.runId, message.id);
      tx.updateRunStatus(input.runId, input.sessionId, "completed", message.id);

      const outboxRows: OutboxRow[] = [];
      if (!input.childAgentId) {
        outboxRows.push(
          this.appendEnvelope(tx, input, {
            type: "stream_output",
            session_id: input.sessionId,
            run_id: input.runId,
            call_id: input.rootCallId,
            agent_id: input.agentName,
            payload: { phase: "final", content: message.content },
          }),
          this.appendEnvelope(tx, input, {
            type: "state_sync",
            session_id: input.sessionId,
            run_id: input.runId,
            payload: { category: "message_saved", ref: { message_id: message.id, seq: message.seq } },
          }),
          this.appendEnvelope(tx, input, {
            type: "agent_ended",
            session_id: input.sessionId,
            run_id: input.runId,
            call_id: input.rootCallId,
            agent_id: input.agentName,
            payload: { phase: "end", result: message.content.slice(0, 500), success: true },
          }),
          this.appendEnvelope(tx, input, {
            type: "run_ended",
            session_id: input.sessionId,
            run_id: input.runId,
            payload: { status: "completed" },
          }),
        );
      }

      return { message, steps: [finalStep, runEndStep], outboxRows };
    });
  }

  private recordFailed(input: RunFailedRecordInput): RunTerminalRecord {
    // 收口打断前「已 start 未 end」的悬空工具调用：补 tool_result（run_step + message + envelope）。
    // 保证 intent assistant(tool_use) ↔ role:tool(tool_result) 配对——否则下次 run 加载历史时，
    // 悬空 tool_use 无配对 tool_result，厂商 API 拒绝（tool_use 必须紧跟 tool_result）。
    const danglingToolCalls = input.status === "interrupted"
      ? this.collectDanglingToolCalls(input)
      : [];
    return this.conversationStore.runInTransaction((tx) => {
      // interrupted 时落库一条 assistant 锚点消息：承载打断前已记录的工具调用步骤，
      // 并让前端刷新后能恢复"已停止生成"状态（metadata.interrupted）。
      // filterHistoryMessages 会把该消息排除出后续 LLM 上下文，故不污染新 run。
      let message: MessageInfo | null = null;
      if (input.status === "interrupted") {
        message = tx.addMessage({
          sessionId: input.sessionId,
          role: "assistant",
          content: "",
          metadata: { interrupted: true, ...input.finalMetadata },
          threadKey: input.threadKey,
          childAgentId: input.childAgentId ?? null,
        });
        tx.updateRunStepsMessageId(input.sessionId, input.runId, message.id);
      }
      tx.updateRunStatus(input.runId, input.sessionId, input.status, message?.id ?? null);
      const runEndStep = tx.addRunStep({
        sessionId: input.sessionId,
        runId: input.runId,
        stepType: "execution.step",
        payload: input.runEndStepPayload,
      });

      const steps: RunStepRecord[] = [runEndStep];
      const outboxRows: OutboxRow[] = [];
      for (const tool of danglingToolCalls) {
        steps.push(
          tx.addRunStep({
            sessionId: input.sessionId,
            runId: input.runId,
            stepType: "execution.step",
            payload: this.buildDanglingToolResultStep(input, tool),
          }),
        );
        // role:tool observation 消息：配对 intent assistant 的 tool_use，解厂商 API 报错。
        tx.addMessage({
          sessionId: input.sessionId,
          role: "tool",
          content: INTERRUPTED_TOOL_OBSERVATION,
          toolCallId: tool.callId,
          name: tool.toolName,
          threadKey: input.threadKey,
          childAgentId: input.childAgentId ?? null,
          metadata: {
            react_intermediate: true,
            msg_type: "observation",
            round: tool.round + 1,
            run_id: input.runId,
            task_id: input.taskId,
            request_id: input.requestId,
            agent: input.agentName,
            agent_name: tool.agentName,
            thread_key: input.threadKey,
            conversation_scope: input.childAgentId ? "child" : "root",
            visible_to_user: false,
            execution_kind: "agent_stream",
            interrupted: true,
          },
        });
      }
      if (!input.childAgentId) {
        for (const tool of danglingToolCalls) {
          outboxRows.push(this.appendEnvelope(tx, input, this.buildDanglingToolResultEnvelope(input, tool)));
        }
        outboxRows.push(
          this.appendEnvelope(tx, input, {
            type: "agent_ended",
            session_id: input.sessionId,
            run_id: input.runId,
            call_id: input.rootCallId,
            agent_id: input.agentName,
            payload: { phase: "end", result: input.agentResult.slice(0, 500), success: false },
          }),
          this.appendEnvelope(tx, input, {
            type: "run_ended",
            session_id: input.sessionId,
            run_id: input.runId,
            payload: { status: input.status, reason: input.errorMessage },
          }),
        );
      }

      return { message, steps, outboxRows };
    });
  }

  /**
   * 收集 run 内「已 start 未 end」的悬空工具调用（按 tool_call_id 配对 start/end step）。
   * 打断发生在工具执行阶段时，已 emit tool_call(start) 但未 emit tool_result(end)。
   */
  private collectDanglingToolCalls(input: RunFailedRecordInput): DanglingToolCall[] {
    const steps = this.conversationStore.listRunSteps({ sessionId: input.sessionId, runId: input.runId, limit: 1000 });
    const started = new Map<string, RunStepInfo>();
    const ended = new Set<string>();
    for (const step of steps) {
      const payload = step.payload ?? {};
      if (payload.kind !== "tool") continue;
      const callId = asString(payload.tool_call_id ?? payload.call_id);
      if (!callId) continue;
      if (payload.phase === "end") {
        ended.add(callId);
      } else if (payload.phase === "start") {
        started.set(callId, step);
      }
    }
    const dangling: DanglingToolCall[] = [];
    for (const [callId, step] of started) {
      if (ended.has(callId)) continue;
      const payload = step.payload;
      dangling.push({
        callId,
        toolName: asString(payload.tool_name) ?? "unknown",
        arguments: isRecord(payload.arguments) ? payload.arguments : {},
        round: typeof payload.round === "number" ? payload.round : 0,
        order: typeof payload.order === "number" ? payload.order : 1,
        roundIndex: typeof payload.round_index === "number" ? payload.round_index : 1,
        agentName: asString(payload.agent_name) ?? input.agentName,
        agentDisplayName: asString(payload.agent_display_name) ?? input.agentDisplayName,
      });
    }
    return dangling;
  }

  private buildDanglingToolResultStep(input: RunFailedRecordInput, tool: DanglingToolCall): Record<string, unknown> {
    return {
      kind: "tool",
      phase: "end",
      step_id: `${tool.callId}:tool`,
      parent_step_id: `${input.rootCallId}:round:${tool.round}`,
      agent_name: tool.agentName,
      agent_display_name: tool.agentDisplayName,
      tool_name: tool.toolName,
      call_id: tool.callId,
      tool_call_id: tool.callId,
      parent_call_id: input.rootCallId,
      arguments: tool.arguments,
      round: tool.round,
      status: "error",
      success: false,
      summary: INTERRUPTED_TOOL_SUMMARY,
      observation: INTERRUPTED_TOOL_OBSERVATION,
      result_preview: INTERRUPTED_TOOL_OBSERVATION,
      elapsed_time: 0,
      order: tool.order,
      round_index: tool.roundIndex,
      run_id: input.runId,
      task_id: input.taskId,
      request_id: input.requestId,
    };
  }

  private buildDanglingToolResultEnvelope(input: RunFailedRecordInput, tool: DanglingToolCall): Envelope {
    return {
      type: "tool_result",
      session_id: input.sessionId,
      run_id: input.runId,
      call_id: tool.callId,
      agent_id: tool.agentName,
      payload: {
        tool: tool.toolName,
        mode: "projection",
        phase: "end",
        ok: false,
        status: "failed",
        observation: INTERRUPTED_TOOL_OBSERVATION,
        summary: INTERRUPTED_TOOL_SUMMARY,
        lineage: { parent_call_id: input.rootCallId },
      },
    };
  }

  private appendEnvelope(
    tx: Parameters<Parameters<ConversationStore["runInTransaction"]>[0]>[0],
    input: { sessionId: string; runId: string },
    envelope: Envelope,
  ): OutboxRow {
    return tx.appendOutbox({
      sessionId: input.sessionId,
      runId: input.runId,
      eventType: `client.${envelope.type}`,
      aggregateType: "run",
      aggregateId: input.runId,
      payload: { client_event: envelope },
    });
  }
}
