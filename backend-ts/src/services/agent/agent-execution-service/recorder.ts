import type { MessageInfo } from "../../../contracts/session.js";
import type { ConversationStore, RunStepRecord } from "../../stores/conversation-store.js";
import type { OutboxRow } from "../../stores/conversation-store/types.js";

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
  finalMessage: {
    id: string;
    content: string;
    metadata: Record<string, unknown>;
  };
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
  runEndStepPayload: Record<string, unknown>;
  finalMetadata: Record<string, unknown>;
}

export interface RunTerminalRecord {
  message: MessageInfo | null;
  steps: RunStepRecord[];
  outboxRows: OutboxRow[];
}

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

      const common = commonEventData(input);
      const outboxRows = [
        tx.appendOutbox({
          sessionId: input.sessionId,
          runId: input.runId,
          eventType: "execution.step_recorded",
          aggregateType: "run",
          aggregateId: input.runId,
          payload: { ...common, step: input.finalStepPayload },
        }),
        tx.appendOutbox({
          sessionId: input.sessionId,
          runId: input.runId,
          eventType: "run.final_answer_recorded",
          aggregateType: "message",
          aggregateId: message.id,
          payload: {
            ...common,
            message_id: message.id,
            content: message.content,
            metadata: input.finalMetadata,
          },
        }),
        tx.appendOutbox({
          sessionId: input.sessionId,
          runId: input.runId,
          eventType: "agent.call_finished",
          aggregateType: "run",
          aggregateId: input.runId,
          payload: {
            ...common,
            call_id: input.rootCallId,
            result: message.content.slice(0, 500),
            success: true,
          },
        }),
        tx.appendOutbox({
          sessionId: input.sessionId,
          runId: input.runId,
          eventType: "execution.step_recorded",
          aggregateType: "run",
          aggregateId: input.runId,
          payload: { ...common, step: input.runEndStepPayload },
        }),
        tx.appendOutbox({
          sessionId: input.sessionId,
          runId: input.runId,
          eventType: "message.saved",
          aggregateType: "message",
          aggregateId: message.id,
          payload: {
            ...common,
            message_id: message.id,
            seq: message.seq,
            role: message.role,
          },
        }),
        tx.appendOutbox({
          sessionId: input.sessionId,
          runId: input.runId,
          eventType: "run.completed",
          aggregateType: "run",
          aggregateId: input.runId,
          payload: {
            ...common,
            final_message_id: message.id,
            metadata: input.finalMetadata,
          },
        }),
      ];

      return { message, steps: [finalStep, runEndStep], outboxRows };
    });
  }

  private recordFailed(input: RunFailedRecordInput): RunTerminalRecord {
    return this.conversationStore.runInTransaction((tx) => {
      tx.updateRunStatus(input.runId, input.sessionId, input.status);
      const runEndStep = tx.addRunStep({
        sessionId: input.sessionId,
        runId: input.runId,
        stepType: "execution.step",
        payload: input.runEndStepPayload,
      });

      const common = commonEventData(input);
      const outboxRows = [
        tx.appendOutbox({
          sessionId: input.sessionId,
          runId: input.runId,
          eventType: "agent.call_finished",
          aggregateType: "run",
          aggregateId: input.runId,
          payload: {
            ...common,
            call_id: input.rootCallId,
            result: input.agentResult.slice(0, 500),
            success: false,
          },
        }),
        tx.appendOutbox({
          sessionId: input.sessionId,
          runId: input.runId,
          eventType: "execution.step_recorded",
          aggregateType: "run",
          aggregateId: input.runId,
          payload: { ...common, step: input.runEndStepPayload },
        }),
        tx.appendOutbox({
          sessionId: input.sessionId,
          runId: input.runId,
          eventType: "run.error_reported",
          aggregateType: "run",
          aggregateId: input.runId,
          payload: {
            ...common,
            error: input.errorMessage,
            error_type: input.errorType,
          },
        }),
        tx.appendOutbox({
          sessionId: input.sessionId,
          runId: input.runId,
          eventType: input.status === "interrupted" ? "run.interrupted" : "run.failed",
          aggregateType: "run",
          aggregateId: input.runId,
          payload: {
            ...common,
            status: input.status,
            error: input.errorMessage,
            metadata: input.finalMetadata,
          },
        }),
      ];

      return { message: null, steps: [runEndStep], outboxRows };
    });
  }
}

function commonEventData(input: {
  sessionId: string;
  runId: string;
  taskId: string;
  requestId: string;
  agentName: string;
  agentDisplayName: string;
}): Record<string, unknown> {
  return {
    session_id: input.sessionId,
    run_id: input.runId,
    task_id: input.taskId,
    request_id: input.requestId,
    agent_name: input.agentName,
    agent_display_name: input.agentDisplayName,
  };
}
