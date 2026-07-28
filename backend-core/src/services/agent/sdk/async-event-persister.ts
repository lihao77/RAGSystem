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
import type { SessionHistoryPort } from "../../../contracts/session/session-history.js";
import type { SessionIdentity } from "../../../contracts/session/session.js";
import {
  buildExecutionEnvelopeRunStep,
  buildExpiredRunLeaseRecord,
} from "../../runtime/event-outbox/execution-envelope-archive.js";

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
  sessionIdentity: SessionIdentity;
  parentRunId?: string | null;
  parentCallId?: string | null;
  childAgentId?: string | null;
  messageMetadata?: Record<string, unknown> | null;
  initialUserMessage?: { id: string; content: string; metadata?: Record<string, unknown> | null };
  pendingUserMessageId?: string | null;
  sessionMaintenanceToken?: string | null;
  initialEnvelopes?: readonly Envelope[];
}

export interface AsyncFinalMessageInput {
  id?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/** Deployment-neutral kernel persister backed by a tenant-bound RuntimeStorage adapter. */
export class AsyncKernelEventPersister {
  private finalMessage: { id: string; seq: number; content: string } | null = null;
  private leaseHeartbeat: ReturnType<typeof setInterval> | null = null;
  private leaseLostError: Error | null = null;
  private leaseRenewal: Promise<void> | null = null;

  constructor(
    private readonly storage: RuntimeStorage,
    private readonly clientEvents: Pick<ClientEventPublisherPort, "prepare" | "deliver" | "flush">,
    private readonly ctx: AsyncPersisterRunContext,
    private readonly fileHistory: Pick<SessionHistoryPort, "makeSnapshot"> | null = null,
  ) {
    if (storage.tenantId !== ctx.tenantId) {
      throw new Error(`runtime storage tenant mismatch: expected ${ctx.tenantId}, received ${storage.tenantId}`);
    }
  }

  async startRun(): Promise<ExecutionStartDisposition> {
    if (this.ctx.parentRunId != null) await this.ensureRunLease();
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
      session: this.ctx.sessionIdentity,
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
      ...(this.ctx.pendingUserMessageId ? { pendingUserMessageId: this.ctx.pendingUserMessageId } : {}),
      ...(this.ctx.sessionMaintenanceToken ? { sessionMaintenanceToken: this.ctx.sessionMaintenanceToken } : {}),
      ...(this.ctx.parentRunId != null ? { leaseRootRunId: this.ctx.rootRunId ?? null } : {}),
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
    const result = this.ctx.parentRunId == null && (this.ctx.initialUserMessage || this.ctx.pendingUserMessageId)
      ? await this.storage.operations.startOrAppendRoot({
          ...startInput,
          followupFactory: ({ activeRunId, roundIndex }) => ({
            message: {
              messageId: this.ctx.initialUserMessage!.id,
              sessionId: this.ctx.sessionId,
              role: "user",
              content: this.ctx.initialUserMessage!.content,
              threadKey: this.ctx.threadKey,
              metadata: {
                ...(this.ctx.initialUserMessage!.metadata ?? {}),
                agent: this.ctx.agentName,
                run_id: activeRunId,
                request_id: this.ctx.requestId ?? null,
                execution_kind: "session_followup",
                source: "running_session",
                followup_pending: true,
                round_index: roundIndex,
              },
            },
            recordFactory: (message) => [{
              ...this.clientEvents.prepare(this.ctx.sessionId, {
                type: "state_sync",
                session_id: this.ctx.sessionId,
                run_id: activeRunId,
                payload: {
                  category: "message_saved",
                  ref: {
                    message_id: message.id,
                    seq: message.seq,
                    role: message.role,
                    request_id: this.ctx.requestId ?? undefined,
                    round_index: roundIndex,
                  },
                },
              }, {
                eventId: `${message.id}:followup:state_sync`,
                runId: activeRunId,
                aggregateType: "run",
                aggregateId: activeRunId,
              }),
            }],
          }),
          buildExpiredRunEndedRecord: (run) => buildExpiredRunLeaseRecord(run.sessionId, run.runId),
        })
      : { kind: "started" as const, ...await this.storage.operations.startRun(startInput) };
    // Delivery occurs after the atomic commit. A transport failure leaves the
    // rows pending for the dispatcher and must not roll back a durable start.
    const records = result.records ?? [];
    if (records.length > 0) {
      void this.clientEvents.deliver(records.map((record) => record.outbox)).catch(() => undefined);
    }
    if (result.kind === "followup") {
      return {
        kind: "followup",
        activeRunId: result.activeRunId,
        queueAccepted: result.message !== undefined || this.ctx.pendingUserMessageId != null,
        ...(result.message ? { messageId: result.message.id, messageSeq: result.message.seq } : {}),
      };
    }
    if (this.isRootRun()) this.startLeaseHeartbeat();
    return { kind: "started" };
  }

  async persist(event: KernelEvent): Promise<void> {
    await this.ensureRunLease();
    if (event.type === "tool_result") {
      const toolMedia = Array.isArray(event.metadata.tool_result_media)
        ? event.metadata.tool_result_media
        : [];
      await this.storage.operations.persistMessage({
        leaseRootRunId: this.ctx.rootRunId ?? this.ctx.runId,
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
    try {
      await this.ensureRunLease();
      const persistedFinal = this.buildFinalMessage(status, finalMessage);
      const rootRunId = this.ctx.rootRunId ?? this.ctx.runId;
      const isRootRun = this.ctx.runId === rootRunId && this.ctx.parentRunId == null;
      await this.clientEvents.flush(this.ctx.sessionId);
      await this.ensureRunLease();
      const result = await this.storage.operations.finalizeRun({
      runId: this.ctx.runId,
      sessionId: this.ctx.sessionId,
      status,
      leaseRootRunId: rootRunId,
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
      buildTerminalRecords: (message, closedToolMessages) => this.buildTerminalRecords(
        status,
        message,
        closedToolMessages,
        error,
      ),
      });

      this.finalMessage = result.finalMessage
        ? { id: result.finalMessage.id, seq: result.finalMessage.seq, content: result.finalMessage.content }
        : null;
      await this.clientEvents.deliver(result.records.map((record) => record.outbox));
      if (status === "completed" && result.finalMessage) {
        await this.makeFileSnapshot(result.finalMessage.seq);
      }
      return { readyResumeInteractionIds: result.readyResumeInteractionIds };
    } finally {
      this.stopLeaseHeartbeat();
    }
  }

  async resolveFinalMessage(): Promise<{ id: string; seq: number; content: string } | null> {
    return this.finalMessage;
  }

  private isRootRun(): boolean {
    const rootRunId = this.ctx.rootRunId ?? this.ctx.runId;
    return this.ctx.parentRunId == null && this.ctx.runId === rootRunId;
  }

  private startLeaseHeartbeat(): void {
    if (!this.storage.operations.renewRunLease || this.leaseHeartbeat) return;
    this.leaseHeartbeat = setInterval(() => {
      void this.renewRunLease().catch(() => undefined);
    }, 20_000);
    this.leaseHeartbeat.unref?.();
  }

  private stopLeaseHeartbeat(): void {
    if (!this.leaseHeartbeat) return;
    clearInterval(this.leaseHeartbeat);
    this.leaseHeartbeat = null;
  }

  private async ensureRunLease(): Promise<void> {
    if (!this.storage.operations.renewRunLease) return;
    if (this.leaseLostError) throw this.leaseLostError;
    await this.renewRunLease();
    if (this.leaseLostError) throw this.leaseLostError;
  }

  private async renewRunLease(): Promise<void> {
    if (!this.storage.operations.renewRunLease) return;
    if (this.leaseRenewal) return this.leaseRenewal;
    this.leaseRenewal = (async () => {
      const result = await this.storage.operations.renewRunLease!({
        sessionId: this.ctx.sessionId,
        rootRunId: this.ctx.rootRunId ?? this.ctx.runId,
      });
      if (!result.renewed) {
        this.stopLeaseHeartbeat();
        this.leaseLostError = new Error(`root run lease was lost: ${this.ctx.rootRunId ?? this.ctx.runId}`);
      }
    })();
    try {
      await this.leaseRenewal;
    } finally {
      this.leaseRenewal = null;
    }
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
      leaseRootRunId: this.ctx.rootRunId ?? this.ctx.runId,
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
    closedToolMessages: readonly {
      tool_call_id?: string | undefined;
      name?: string | undefined;
      content: string;
    }[] | undefined,
    error: unknown,
  ): RuntimeRecordEnvelopeInput[] {
    if (status === "suspended" || this.ctx.childAgentId) return [];
    const events = buildTerminalEnvelopes(this.ctx, status, finalMessage, closedToolMessages ?? [], error);
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
  closedToolMessages: readonly {
    tool_call_id?: string | undefined;
    name?: string | undefined;
    content: string;
  }[],
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
    ...closedToolMessages.flatMap((message) => {
      if (!message.tool_call_id) return [];
      return [{
        type: "tool_result" as const,
        session_id: ctx.sessionId,
        run_id: ctx.runId,
        call_id: message.tool_call_id,
        agent_id: ctx.agentName,
        payload: {
          tool: message.name ?? "",
          phase: "end" as const,
          ok: false,
          status: "failed" as const,
          observation: message.content,
          summary: "工具执行被中断",
          lineage: { parent_call_id: ctx.rootCallId },
        },
      }];
    }),
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
