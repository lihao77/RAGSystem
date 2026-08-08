import type {
  AgentExecuteResult,
  CollaborateRequest,
  ExecuteRequest,
} from "../../../contracts/execution/execution.js";
import type { AgentExecutionEventPublisher } from "./event-publisher.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";
import type { PendingInteractionPort } from "../../../contracts/runtime/pending-interactions.js";
import type { ClientEventPublisherPort } from "../../../contracts/runtime/core-runtime-ports.js";
import type { RuntimeStorage } from "../../../contracts/storage/runtime-storage.js";
import type { MessageInfo } from "../../../contracts/session/session.js";
import type { AssistantContentPart } from "@ragsystem/agent-protocol";
import { buildExecutionEnvelopeRunStep } from "../../runtime/event-outbox/execution-envelope-archive.js";

export interface SessionControlApi {
  stopSession(sessionId: string): Promise<boolean>;
  collaborateSequentially(
    request: CollaborateRequest,
    requestId: string,
  ): Promise<{ results: AgentExecuteResult[]; session_id: string; total_tasks: number }>;
}

export interface SessionControlDeps {
  statusTracker: AgentExecutionStatusTracker;
  eventPublisher: AgentExecutionEventPublisher;
  pendingInteractions: PendingInteractionPort;
  runtimeStorage: RuntimeStorage;
  clientEvents: Pick<ClientEventPublisherPort, "publish" | "deliver">;
  /** collaborateSequentially 顺序复用 executeSynchronously（由 launchers 提供，注入打破环）。 */
  executeSynchronously: (request: ExecuteRequest, requestId: string) => Promise<AgentExecuteResult>;
}

/** stopSession 中断 + collaborateSequentially 顺序多任务（复用 executeSynchronously）。 */
export function createSessionControl(deps: SessionControlDeps): SessionControlApi {
  return {
    async stopSession(sessionId) {
      const handle = deps.statusTracker.getRunningHandleBySession(sessionId);
      if (!handle) {
        const result = await deps.runtimeStorage.operations.interruptSession({
          sessionId,
          buildTerminalRecords: (run, finalMessage) => buildInterruptedTerminalRecords(sessionId, run, finalMessage),
        });
        await deps.pendingInteractions.cancelSession(sessionId, "suspended run cancelled");
        await deps.clientEvents.deliver(result.records.map((record) => record.outbox));
        return result.interruptedRuns.length > 0 || result.cancelledInteractions > 0;
      }
      deps.eventPublisher.publishUserInterrupt(handle.status, "user_stop");
      handle.abortController.abort();
      return true;
    },
    async collaborateSequentially(request, requestId) {
      const sessionId = request.session_id?.trim() || cryptoRandom();
      const results: AgentExecuteResult[] = [];
      for (const [index, taskItem] of request.tasks.entries()) {
        const executeRequest: ExecuteRequest = {
          task: taskItem.task,
          session_id: sessionId,
          userId: request.userId,
        };
        if (taskItem.agent !== undefined) {
          executeRequest.agent = taskItem.agent;
        }
        const result = await deps.executeSynchronously(executeRequest, `${requestId}:${index + 1}`);
        results.push(result);
        if (!result.success) {
          break;
        }
      }
      return {
        results,
        session_id: sessionId,
        total_tasks: request.tasks.length,
      };
    },
  };
}

function buildInterruptedTerminalRecords(
  sessionId: string,
  run: { runId: string; parentRunId: string | null },
  finalMessage: MessageInfo,
) {
  const agentName = typeof finalMessage.metadata.agent_name === "string"
    ? finalMessage.metadata.agent_name
    : "unknown";
  const contentParts: AssistantContentPart[] = finalMessage.content_parts.flatMap((part): AssistantContentPart[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.type === "file_ref") {
      return [{
        type: "file_ref" as const,
        file_path: part.file_path,
        presentation: part.presentation,
        ...(part.caption ? { caption: part.caption } : {}),
      }];
    }
    return [];
  });
  const reason = typeof finalMessage.metadata.terminal_reason === "string"
    ? finalMessage.metadata.terminal_reason
    : "未提供中断原因";
  const events = [
    {
      type: "stream_output" as const,
      session_id: sessionId,
      run_id: run.runId,
      call_id: run.runId,
      agent_id: agentName,
      payload: { phase: "final" as const, content: finalMessage.content, content_parts: contentParts },
    },
    {
      type: "state_sync" as const,
      session_id: sessionId,
      run_id: run.runId,
      payload: {
        category: "message_saved" as const,
        ref: {
          message_id: finalMessage.id,
          seq: finalMessage.seq,
          role: "assistant",
          content_parts: finalMessage.content_parts,
        },
      },
    },
    {
      type: "agent_ended" as const,
      session_id: sessionId,
      run_id: run.runId,
      call_id: run.runId,
      agent_id: agentName,
      payload: {
        phase: "end" as const,
        display_name: agentName,
        result: finalMessage.content.slice(0, 500),
        success: false,
      },
    },
    {
      type: "run_ended" as const,
      session_id: sessionId,
      run_id: run.runId,
      payload: { status: "interrupted" as const, reason },
    },
  ];
  return events.map((event, index) => {
    const eventId = `${run.runId}:session-stop:terminal:${index}:${event.type}`;
    return {
      step: buildExecutionEnvelopeRunStep(sessionId, run.runId, event, eventId),
      outbox: {
        sessionId,
        runId: run.runId,
        eventId,
        eventType: `client.${event.type}`,
        aggregateType: "run" as const,
        aggregateId: run.runId,
        payload: { client_event: event },
      },
    };
  });
}

function cryptoRandom(): string {
  return crypto.randomUUID();
}
