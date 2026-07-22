import { extractText, type ChatMessage } from "@ragsystem/agent-llm";
import type { KernelEvent } from "@ragsystem/agent-sdk";

import type {
  AddMessageInput,
  PutProviderContinuationInput,
} from "../../../contracts/conversation-store/index.js";
import type { Envelope } from "../../../contracts/events.js";
import { MSG_TYPE } from "../../../contracts/message-kinds.js";
import type {
  RuntimeFinalizeStatus,
  RuntimeRecordEnvelopeInput,
  RuntimeStorage,
  RuntimeStartRunInput,
} from "../../../contracts/storage/runtime-storage.js";
import type { TenantId } from "../../../identity/types.js";
import type { ExecutionStartDisposition } from "../../../contracts/execution/execution-storage.js";
import type { ClientEventPublisherPort } from "../../../contracts/runtime/core-runtime-ports.js";
import { buildExecutionEnvelopeRunStep } from "../../runtime/event-outbox/execution-envelope-archive.js";

export interface AsyncPersisterRunContext {
  tenantId: TenantId;
  sessionId: string;
  runId: string;
  threadKey: string;
  agentName: string;
  agentDisplayName: string;
  rootCallId: string;
  rootRunId?: string;
  taskId?: string | null;
  providerType?: string;
  executionKind?: string;
  taskSummary?: string;
  requestId?: string | null;
  userId?: string | null;
  parentRunId?: string | null;
  parentCallId?: string | null;
  childAgentId?: string | null;
  messageMetadata?: Record<string, unknown> | null;
  initialUserMessage?: { id: string; content: string; metadata?: Record<string, unknown> | null };
  initialEnvelopes?: readonly Envelope[];
}

export interface AsyncFinalMessageInput {
  id?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface FileSnapshotPort {
  makeSnapshot(sessionId: string, messageSeq: number): string | null | Promise<string | null>;
}

/** Deployment-neutral kernel persister backed by a tenant-bound RuntimeStorage adapter. */
export class AsyncKernelEventPersister {
  private finalMessage: { id: string; seq: number; content: string } | null = null;

  constructor(
    private readonly storage: RuntimeStorage,
    private readonly clientEvents: Pick<ClientEventPublisherPort, "prepare" | "deliver" | "flush">,
    private readonly ctx: AsyncPersisterRunContext,
    private readonly fileHistory: FileSnapshotPort | null = null,
  ) {
    if (storage.tenantId !== ctx.tenantId) {
      throw new Error(`runtime storage tenant mismatch: expected ${ctx.tenantId}, received ${storage.tenantId}`);
    }
  }

  async startRun(): Promise<ExecutionStartDisposition> {
    const initialRecords = (this.ctx.initialEnvelopes ?? []).map((event, index) => this.clientEvents.prepare(
      this.ctx.sessionId,
      event,
      {
        eventId: `${this.ctx.runId}:initial:${index}:${event.type}`,
        runId: this.ctx.runId,
        aggregateType: "run",
        aggregateId: this.ctx.runId,
      },
    ));
    const startInput: RuntimeStartRunInput = {
      session: {
        sessionId: this.ctx.sessionId,
        userId: this.ctx.userId ?? null,
      },
      run: {
        runId: this.ctx.runId,
        sessionId: this.ctx.sessionId,
        status: "running",
        agentName: this.ctx.agentName,
        threadKey: this.ctx.threadKey,
        ...(this.ctx.executionKind ? { entrypoint: this.ctx.executionKind } : {}),
        ...(this.ctx.taskSummary !== undefined ? { taskSummary: this.ctx.taskSummary } : {}),
        ...(this.ctx.requestId !== undefined ? { requestId: this.ctx.requestId } : {}),
        ...(this.ctx.userId !== undefined ? { userId: this.ctx.userId } : {}),
        ...(this.ctx.parentRunId !== undefined ? { parentRunId: this.ctx.parentRunId } : {}),
        ...(this.ctx.parentCallId !== undefined ? { parentCallId: this.ctx.parentCallId } : {}),
        ...(this.ctx.childAgentId !== undefined ? { childAgentId: this.ctx.childAgentId } : {}),
      },
      ...(this.ctx.initialUserMessage ? {
        initialUserMessage: {
          messageId: this.ctx.initialUserMessage.id,
          sessionId: this.ctx.sessionId,
          role: "user",
          content: this.ctx.initialUserMessage.content,
          threadKey: this.ctx.threadKey,
          metadata: this.ctx.initialUserMessage.metadata ?? {},
        },
      } : {}),
      ...(initialRecords.length > 0 ? { initialRecords } : {}),
    };
    const result = this.ctx.parentRunId == null && this.ctx.initialUserMessage
      ? await this.storage.operations.startOrAppendRoot({
          ...startInput,
          followupFactory: ({ activeRunId, roundIndex }) => {
            const proposed = this.ctx.initialUserMessage!;
            const { run_id: _runId, task_id: _taskId, execution_kind: _kind, ...baseMetadata } = proposed.metadata ?? {};
            return {
              message: {
                messageId: proposed.id,
                sessionId: this.ctx.sessionId,
                role: "user" as const,
                content: proposed.content,
                threadKey: this.ctx.threadKey,
                metadata: {
                  ...baseMetadata,
                  agent: this.ctx.agentName,
                  run_id: activeRunId,
                  request_id: this.ctx.requestId ?? null,
                  execution_kind: "session_followup",
                  source: "running_session",
                  round_index: roundIndex,
                },
              },
              recordFactory: (message) => [this.clientEvents.prepare(
                this.ctx.sessionId,
                {
                  type: "state_sync",
                  session_id: this.ctx.sessionId,
                  run_id: activeRunId,
                  payload: { category: "message_saved", ref: { message_id: message.id, seq: message.seq, role: message.role, request_id: this.ctx.requestId ?? undefined } },
                },
                { eventId: `${message.id}:followup-saved`, runId: activeRunId, aggregateType: "run", aggregateId: activeRunId },
              )],
            };
          },
        })
      : { kind: "started" as const, ...await this.storage.operations.startRun(startInput) };
    // Delivery occurs after the atomic commit. A transport failure leaves the
    // rows pending for the dispatcher and must not roll back a durable start.
    if (result.records.length > 0) {
      void this.clientEvents.deliver(result.records.map((record) => record.outbox)).catch(() => undefined);
    }
    return result.kind === "followup"
      ? { kind: "followup", activeRunId: result.activeRunId, messageId: result.message.id }
      : { kind: "started" };
  }

  async persist(event: KernelEvent): Promise<void> {
    if (event.type === "tool_result") {
      const toolMedia = Array.isArray(event.metadata.tool_result_media)
        ? event.metadata.tool_result_media
        : [];
      await this.storage.operations.persistMessage({
        message: {
          messageId: `${this.ctx.runId}:tool:${event.toolCallId}`,
          sessionId: this.ctx.sessionId,
          role: "tool",
          content: event.observation,
          threadKey: this.ctx.threadKey,
          toolCallId: event.toolCallId,
          name: event.toolName,
          metadata: {
            ...this.messageMeta(event.round),
            msg_type: MSG_TYPE.OBSERVATION,
            ...(toolMedia.length > 0
              ? { extensions: [{ kind: "tool_result_media", data: { media: toolMedia } }] }
              : {}),
          },
        },
      });
      return;
    }
    if (event.type === "assistant_intermediate") {
      await this.persistAssistant(event.message, event.round);
    }
  }

  async finalize(
    status: RuntimeFinalizeStatus,
    finalMessage: AsyncFinalMessageInput | null,
    error: unknown = null,
  ): Promise<{ readyResumeInteractionIds: string[] }> {
    const persistedFinal = this.buildFinalMessage(status, finalMessage);
    const rootRunId = this.ctx.rootRunId ?? this.ctx.runId;
    const isRootRun = this.ctx.runId === rootRunId && this.ctx.parentRunId == null;
    await this.clientEvents.flush(this.ctx.sessionId);
    const result = await this.storage.operations.finalizeRun({
      runId: this.ctx.runId,
      sessionId: this.ctx.sessionId,
      status,
      finalMessage: persistedFinal,
      ...(persistedFinal ? { attachStepsToFinalMessage: true } : {}),
      ...(isRootRun ? { interactionRootRunId: rootRunId } : {}),
      ...(status === "completed" || status === "interrupted"
        ? { deleteProviderContinuationThreadKey: this.ctx.threadKey }
        : {}),
      ...(status === "interrupted" ? {
        closeDanglingToolCalls: {
          threadKey: this.ctx.threadKey,
          agentName: this.ctx.agentName,
        },
      } : {}),
      buildTerminalRecords: (message) => this.buildTerminalRecords(status, message, error),
    });

    this.finalMessage = result.finalMessage
      ? { id: result.finalMessage.id, seq: result.finalMessage.seq, content: result.finalMessage.content }
      : null;
    await this.clientEvents.deliver(result.records.map((record) => record.outbox));
    if (status === "completed" && result.finalMessage) {
      await this.makeFileSnapshot(result.finalMessage.seq);
    }
    return { readyResumeInteractionIds: result.readyResumeInteractionIds };
  }

  resolveFinalMessage(): { id: string; seq: number; content: string } | null {
    return this.finalMessage;
  }

  private async persistAssistant(message: ChatMessage, round: number): Promise<void> {
    const messageId = `${this.ctx.runId}:intent:${round}`;
    const input: AddMessageInput & { messageId: string } = {
      messageId,
      sessionId: this.ctx.sessionId,
      role: "assistant",
      content: extractText(message.content),
      threadKey: this.ctx.threadKey,
      metadata: { ...this.messageMeta(round), msg_type: MSG_TYPE.INTENT },
    };
    if (message.tool_calls) {
      input.toolCalls = message.tool_calls as AddMessageInput["toolCalls"];
    }
    const providerContinuation = this.buildProviderContinuation(message, messageId);
    await this.storage.operations.persistMessage({
      message: input,
      deleteProviderContinuationThreadKey: this.ctx.threadKey,
      ...(providerContinuation ? { providerContinuation } : {}),
    });
  }

  private buildProviderContinuation(
    message: ChatMessage,
    messageId: string,
  ): PutProviderContinuationInput | null {
    if (!message.provider_continuation || !message.tool_calls?.length) return null;
    const callIds = message.tool_calls.map((call) => call.id);
    const stateIds = new Set(message.provider_continuation.toolCallIds);
    if (callIds.length !== stateIds.size || !callIds.every((id) => stateIds.has(id))) return null;
    if (!this.ctx.providerType) {
      throw new Error("providerType is required to persist provider continuation");
    }
    return {
      messageId,
      sessionId: this.ctx.sessionId,
      threadKey: this.ctx.threadKey,
      providerType: this.ctx.providerType,
      toolCallIds: callIds,
      state: message.provider_continuation,
    };
  }

  private buildFinalMessage(
    status: RuntimeFinalizeStatus,
    finalMessage: AsyncFinalMessageInput | null,
  ): (AddMessageInput & { messageId: string }) | null {
    if (status === "completed") {
      if (!finalMessage) throw new Error("completed finalize requires a final message");
      return {
        messageId: finalMessage.id?.trim() || `${this.ctx.runId}:final`,
        sessionId: this.ctx.sessionId,
        role: "assistant",
        content: finalMessage.content,
        threadKey: this.ctx.threadKey,
        metadata: {
          ...this.finalMessageMeta(),
          msg_type: MSG_TYPE.ASSISTANT_FINAL,
          ...(this.ctx.messageMetadata ?? {}),
          ...(finalMessage.metadata ?? {}),
        },
      };
    }
    if (status === "interrupted") {
      return {
        messageId: `${this.ctx.runId}:interrupted`,
        sessionId: this.ctx.sessionId,
        role: "assistant",
        content: "",
        threadKey: this.ctx.threadKey,
        metadata: {
          ...this.finalMessageMeta(),
          msg_type: MSG_TYPE.ASSISTANT_FINAL,
          interrupted: true,
        },
      };
    }
    return null;
  }

  private buildTerminalRecords(
    status: RuntimeFinalizeStatus,
    finalMessage: { id: string; seq: number; content: string } | null,
    error: unknown,
  ): RuntimeRecordEnvelopeInput[] {
    if (status === "suspended" || this.ctx.childAgentId) return [];
    const events = buildTerminalEnvelopes(this.ctx, status, finalMessage, error);
    return events.map((event, index) => {
      const eventId = `${this.ctx.runId}:terminal:${index}:${event.type}`;
      return {
        step: buildExecutionEnvelopeRunStep(this.ctx.sessionId, this.ctx.runId, event, eventId),
        outbox: {
          sessionId: this.ctx.sessionId,
          runId: this.ctx.runId,
          eventId,
          eventType: `client.${event.type}`,
          aggregateType: "run",
          aggregateId: this.ctx.runId,
          payload: { client_event: event },
        },
      };
    });
  }

  private messageMeta(round: number): Record<string, unknown> {
    return {
      ...this.baseMessageMeta(),
      react_intermediate: true,
      visible_to_user: true,
      round: round + 1,
    };
  }

  private finalMessageMeta(): Record<string, unknown> {
    return this.baseMessageMeta();
  }

  private baseMessageMeta(): Record<string, unknown> {
    return {
      agent_name: this.ctx.agentName,
      run_id: this.ctx.runId,
      agent: this.ctx.agentName,
      thread_key: this.ctx.threadKey,
      conversation_scope: this.ctx.parentCallId != null ? "child" : "root",
      ...(this.ctx.taskId ? { task_id: this.ctx.taskId } : {}),
      ...(this.ctx.requestId ? { request_id: this.ctx.requestId } : {}),
      ...(this.ctx.executionKind ? { execution_kind: this.ctx.executionKind } : {}),
    };
  }

  private async makeFileSnapshot(messageSeq: number): Promise<void> {
    try {
      await this.fileHistory?.makeSnapshot(this.ctx.sessionId, messageSeq);
    } catch {
      // File history is auxiliary and must not invalidate a committed run terminal state.
    }
  }
}

function buildTerminalEnvelopes(
  ctx: AsyncPersisterRunContext,
  status: RuntimeFinalizeStatus,
  finalMessage: { id: string; seq: number; content: string } | null,
  error: unknown,
): Envelope[] {
  if (status === "completed" && finalMessage) {
    return [
      {
        type: "stream_output",
        session_id: ctx.sessionId,
        run_id: ctx.runId,
        call_id: ctx.rootCallId,
        agent_id: ctx.agentName,
        payload: { phase: "final", content: finalMessage.content },
      },
      {
        type: "state_sync",
        session_id: ctx.sessionId,
        run_id: ctx.runId,
        payload: { category: "message_saved", ref: { message_id: finalMessage.id, seq: finalMessage.seq } },
      },
      {
        type: "agent_ended",
        session_id: ctx.sessionId,
        run_id: ctx.runId,
        call_id: ctx.rootCallId,
        agent_id: ctx.agentName,
        payload: {
          phase: "end",
          display_name: ctx.agentDisplayName,
          result: finalMessage.content.slice(0, 500),
          success: true,
        },
      },
      {
        type: "run_ended",
        session_id: ctx.sessionId,
        run_id: ctx.runId,
        payload: { status: "completed" },
      },
    ];
  }
  if (status === "suspended") return [];
  const errorMessage = error instanceof Error ? error.message : String(error);
  return [
    {
      type: "agent_ended",
      session_id: ctx.sessionId,
      run_id: ctx.runId,
      call_id: ctx.rootCallId,
      agent_id: ctx.agentName,
      payload: {
        phase: "end",
        display_name: ctx.agentDisplayName,
        result: status === "interrupted" ? "[已停止生成]" : errorMessage.slice(0, 500),
        success: false,
      },
    },
    {
      type: "run_ended",
      session_id: ctx.sessionId,
      run_id: ctx.runId,
      payload: { status, ...(status !== "interrupted" ? { reason: errorMessage } : {}) },
    },
  ];
}
