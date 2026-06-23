import type { Envelope } from "../../../contracts/events.js";
import type { MessageInfo } from "../../../contracts/session.js";
import type { IConversationTransactionRunner, OutboxRow, RunStepRecord } from "../../../contracts/conversation-store/index.js";

export type RunTerminalStatus = "completed" | "failed" | "interrupted";

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
  constructor(private readonly conversationStore: IConversationTransactionRunner) {}

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

      const outboxRows: OutboxRow[] = [];
      if (!input.childAgentId) {
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

      return { message, steps: [runEndStep], outboxRows };
    });
  }

  private appendEnvelope(
    tx: Parameters<Parameters<IConversationTransactionRunner["runInTransaction"]>[0]>[0],
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
