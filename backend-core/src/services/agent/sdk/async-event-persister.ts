import { extractText, type ChatMessage } from "@ragsystem/agent-llm";
import type { AssistantContentPart, KernelEvent } from "@ragsystem/agent-sdk";

import type {
  AddMessageInput,
} from "../../../contracts/conversation-store/index.js";
import type { Envelope } from "../../../contracts/events.js";
import { MSG_TYPE } from "../../../contracts/message-kinds.js";
import type {
  RuntimeFinalizeStatus,
  RuntimeStorage,
  RuntimeStartRunInput,
} from "../../../contracts/storage/runtime-storage.js";
import { rootMailboxConversationMessage } from "../../../contracts/storage/runtime-storage.js";
import type { AgentMailboxInputType, AgentMailboxSourceKind } from "../../../contracts/storage/agent-mailbox-repository.js";
import type { TenantId } from "../../../identity/types.js";
import type { ExecutionStartDisposition } from "../../../contracts/execution/execution-storage.js";
import type { ClientEventPublisherPort } from "../../../contracts/runtime/core-runtime-ports.js";
import type { SessionHistoryPort } from "../../../contracts/session/session-history.js";
import type { SessionIdentity } from "../../../contracts/session/session.js";
import type { MessageInfo } from "../../../contracts/session/session.js";
import type { MessageContentPart } from "@ragsystem/agent-protocol";
import {
  buildTerminalAssistantMessage,
} from "../../../contracts/storage/runtime-finalization.js";
import { terminalReason } from "./terminal-reason.js";

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
  /** 签发隐藏推理状态的 provider 配置 key（印章）。 */
  providerKey?: string;
  /** 签发隐藏推理状态的模型名（印章）。 */
  model?: string;
  executionKind?: string;
  taskSummary?: string;
  requestId?: string | null;
  userId?: string | null;
  sessionIdentity: SessionIdentity;
  parentRunId?: string | null;
  parentCallId?: string | null;
  lineageParentCallId?: string | null;
  childAgentId?: string | null;
  /** Background child runs retain lineage but own their write lease. */
  ownsRunLease?: boolean;
  messageMetadata?: Record<string, unknown> | null;
  rootMailboxMessage?: {
    id: string;
    inputType: AgentMailboxInputType;
    sourceKind: AgentMailboxSourceKind;
    visibleToUser: boolean;
    sentAt: string;
    contentParts: MessageContentPart[];
    metadata?: Record<string, unknown> | null;
  };
  initialMessage?: AddMessageInput & { messageId: string };
  participantExpectedLastRunId?: string | null;
  initialMailboxMessageId?: string | null;
  followupPolicy?: "queue" | "reject";
  sessionMaintenanceToken?: string | null;
  initialEnvelopes?: readonly Envelope[];
}

export interface AsyncFinalMessageInput {
  id?: string;
  content: string;
  contentParts?: AssistantContentPart[];
  metadata?: Record<string, unknown>;
  /** final 轮思考全文；落库为消息行 thinking part（一等持久化内容）。 */
  reasoning?: string;
  /** final 轮思考 continuation；落库为 provider_state 供跨 run 回放。 */
  providerContinuation?: ChatMessage["provider_continuation"];
}

/** 中断/失败时从事件流 salvage 的当前轮半成品（runtime-adapter 累加器产出）。 */
export interface AsyncTerminalSalvage {
  /** 当前轮已累积的思考全文（reasoning_complete 到达过则视为完整）。 */
  reasoning?: string;
  reasoningComplete?: boolean;
  /** 当前轮已流出的正文（post-XML-parse 增量累积）。 */
  content?: string;
  round?: number;
}

/** Deployment-neutral kernel persister backed by a tenant-bound RuntimeStorage adapter. */
export class AsyncKernelEventPersister {
  private finalMessage: { id: string; seq: number; contentParts: MessageContentPart[] } | null = null;
  private leaseHeartbeat: ReturnType<typeof setInterval> | null = null;
  private leaseLostError: Error | null = null;
  private leaseRenewal: Promise<void> | null = null;
  /**
   * 当前 run 段的 boundary 用户消息 id：行落库（boundary_message_id）与 wire 翻译共用。
   * 初始 = 首条用户消息；认领插嘴（commitRunInput）后翻转——之后所有行归属插嘴段。
   */
  private boundaryMessageId: string | null;

  constructor(
    private readonly storage: RuntimeStorage,
    private readonly clientEvents: Pick<ClientEventPublisherPort, "prepare" | "deliver" | "flush">,
    private readonly ctx: AsyncPersisterRunContext,
    private readonly fileHistory: Pick<SessionHistoryPort, "makeSnapshot"> | null = null,
  ) {
    if (storage.tenantId !== ctx.tenantId) {
      throw new Error(`runtime storage tenant mismatch: expected ${ctx.tenantId}, received ${storage.tenantId}`);
    }
    this.boundaryMessageId = ctx.initialMessage?.messageId ?? ctx.rootMailboxMessage?.id ?? null;
  }

  /** 认领插嘴后由 runtime-adapter 调用，与 wireCtx.boundaryMessageId 同步翻转。 */
  setBoundaryMessageId(id: string | null): void {
    this.boundaryMessageId = id;
  }

  async startRun(): Promise<ExecutionStartDisposition> {
    if (this.ctx.parentRunId != null && !this.ctx.ownsRunLease) await this.ensureRunLease();
    const initialBoundaryMessageId = this.ctx.initialMessage?.messageId ?? this.ctx.rootMailboxMessage?.id ?? null;
    const messageSaved = this.initialMessageSavedEnvelope();
    const prepareInitial = (event: Envelope, eventId: string) => this.clientEvents.prepare(
        this.ctx.sessionId,
        initialBoundaryMessageId && !event.boundary_message_id
          ? { ...event, boundary_message_id: initialBoundaryMessageId }
          : event,
        {
          eventId,
          runId: this.ctx.runId,
          aggregateType: "run",
          aggregateId: this.ctx.runId,
        },
      );
    const initialRecords = [
      ...(messageSaved
        ? [prepareInitial(messageSaved, `${this.ctx.runId}:initial:message_saved`)]
        : []),
      ...(this.ctx.initialEnvelopes ?? []).map((event, index) => prepareInitial(
        event,
        `${this.ctx.runId}:initial:${index}:${event.type}`,
      )),
    ];
    const startInput: RuntimeStartRunInput = {
      session: this.ctx.sessionIdentity,
      run: {
        runId: this.ctx.runId,
        sessionId: this.ctx.sessionId,
        status: "running",
        agentName: this.ctx.agentName,
        agentCallId: this.ctx.rootCallId,
        lineageParentCallId: this.ctx.lineageParentCallId ?? null,
        agentDisplayName: this.ctx.agentDisplayName,
        leaseRootRunId: this.ctx.ownsRunLease ? this.ctx.runId : this.ctx.rootRunId ?? this.ctx.runId,
        threadKey: this.ctx.threadKey,
        ...(this.ctx.executionKind ? { entrypoint: this.ctx.executionKind } : {}),
        ...(this.ctx.taskSummary !== undefined ? { taskSummary: this.ctx.taskSummary } : {}),
        ...(this.ctx.requestId !== undefined ? { requestId: this.ctx.requestId } : {}),
        ...(this.ctx.userId !== undefined ? { userId: this.ctx.userId } : {}),
        ...(this.ctx.parentRunId !== undefined ? { parentRunId: this.ctx.parentRunId } : {}),
        ...(this.ctx.parentCallId !== undefined ? { parentCallId: this.ctx.parentCallId } : {}),
        ...(this.ctx.childAgentId !== undefined ? { childAgentId: this.ctx.childAgentId } : {}),
      },
      ...(this.ctx.sessionMaintenanceToken ? { sessionMaintenanceToken: this.ctx.sessionMaintenanceToken } : {}),
      ...(this.ctx.parentRunId != null && !this.ctx.ownsRunLease ? { leaseRootRunId: this.ctx.rootRunId ?? null } : {}),
      ...(this.ctx.ownsRunLease ? { claimOwnLease: true } : {}),
      ...(initialRecords.length > 0 ? { initialRecords } : {}),
      ...(this.ctx.initialMessage ? { initialMessage: this.ctx.initialMessage } : {}),
      ...(this.ctx.childAgentId && this.ctx.participantExpectedLastRunId !== undefined ? {
        participantRun: {
          childAgentId: this.ctx.childAgentId,
          expectedLastRunId: this.ctx.participantExpectedLastRunId,
        },
      } : {}),
      ...(this.ctx.initialMailboxMessageId ? { initialMailboxMessageId: this.ctx.initialMailboxMessageId } : {}),
    };
    const result = this.ctx.parentRunId == null && this.ctx.rootMailboxMessage
      ? await this.storage.operations.startOrAppendRoot({
          ...startInput,
          mailboxMessage: {
            messageId: this.ctx.rootMailboxMessage.id,
            tenantId: this.ctx.tenantId,
            sessionId: this.ctx.sessionId,
            targetThreadKey: "root",
            kind: "request",
            inputType: this.ctx.rootMailboxMessage.inputType,
            sourceKind: this.ctx.rootMailboxMessage.sourceKind,
            visibleToUser: this.ctx.rootMailboxMessage.visibleToUser,
            sentAt: this.ctx.rootMailboxMessage.sentAt,
            contentParts: this.ctx.rootMailboxMessage.contentParts,
            metadata: this.ctx.rootMailboxMessage.metadata ?? {},
          },
          followupPolicy: this.ctx.followupPolicy ?? "queue",
        })
      : { kind: "started" as const, mailboxMessage: null, ...await this.storage.operations.startRun(startInput) };
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
        queueAccepted: result.mailboxMessage !== null,
        messageId: result.mailboxMessage?.message_id ?? null,
      };
    }
    if (this.isRootRun() || this.ctx.ownsRunLease) this.startLeaseHeartbeat();
    return { kind: "started" };
  }

  private initialMessageSavedEnvelope(): Envelope | null {
    if (this.ctx.parentRunId != null || !this.ctx.rootMailboxMessage) return null;
    const mailbox = this.ctx.rootMailboxMessage;
    const canonical = rootMailboxConversationMessage({
      sessionId: this.ctx.sessionId,
      runId: this.ctx.runId,
      mailboxMessage: {
        messageId: mailbox.id,
        tenantId: this.ctx.tenantId,
        sessionId: this.ctx.sessionId,
        targetThreadKey: "root",
        kind: "request",
        inputType: mailbox.inputType,
        sourceKind: mailbox.sourceKind,
        visibleToUser: mailbox.visibleToUser,
        sentAt: mailbox.sentAt,
        contentParts: mailbox.contentParts,
        metadata: mailbox.metadata ?? {},
      },
    });
    return {
      type: "state_sync",
      session_id: this.ctx.sessionId,
      run_id: this.ctx.runId,
      boundary_message_id: canonical.messageId,
      payload: {
        category: "message_saved",
        ref: {
          message_id: canonical.messageId,
          role: "user",
          request_id: typeof canonical.metadata?.request_id === "string"
            ? canonical.metadata.request_id
            : undefined,
          content_parts: canonical.contentParts ?? [],
          metadata: canonical.metadata ?? {},
        },
      },
    };
  }

  async persist(event: KernelEvent): Promise<void> {
    await this.ensureRunLease();
    if (event.type === "tool_result") {
      const toolMedia = Array.isArray(event.metadata.tool_result_media)
        ? event.metadata.tool_result_media
        : [];
      await this.storage.operations.persistMessage({
        leaseRootRunId: this.leaseRunId(),
        message: {
          messageId: `${this.ctx.runId}:tool:${event.toolCallId}`,
          sessionId: this.ctx.sessionId,
          role: "tool",
          contentParts: [{ type: "text", text: event.observation }],
          threadKey: this.ctx.threadKey,
          childAgentId: this.ctx.childAgentId ?? null,
          toolCallId: event.toolCallId,
          name: event.toolName,
          metadata: {
            ...this.messageMeta(event.round),
            msg_type: MSG_TYPE.OBSERVATION,
            tool_result_ref: event.referenceResult,
            ...(toolMedia.length > 0
              ? { extensions: [{ kind: "tool_result_media", data: { media: toolMedia } }] }
              : {}),
          },
        },
      });
      return;
    }
    if (event.type === "assistant_intermediate") {
      await this.persistAssistant(event.message, event.round, event.reasoning);
    }
  }

  async finalize(
    status: RuntimeFinalizeStatus,
    finalMessage: AsyncFinalMessageInput | null,
    error: unknown = null,
    salvage: AsyncTerminalSalvage | null = null,
  ): Promise<{ readyResumeInteractionIds: string[] }> {
    try {
      await this.ensureRunLease();
      const persistedFinal = this.buildFinalMessage(status, finalMessage, error, salvage);
      const rootRunId = this.ctx.rootRunId ?? this.ctx.runId;
      const isInteractionRoot = this.isRootRun() || this.ctx.ownsRunLease === true;
      await this.clientEvents.flush(this.ctx.sessionId);
      await this.ensureRunLease();
      const result = await this.storage.operations.finalizeRun({
      runId: this.ctx.runId,
      sessionId: this.ctx.sessionId,
      status,
      // 终局记录（final stream/state_sync、悬空工具补齐、agent_ended/run_ended）盖当前
      // boundary，live 路由与行落库一致——中断时悬空工具与其 tool_call 同面板收口。
      ...(this.boundaryMessageId ? { boundaryMessageId: this.boundaryMessageId } : {}),
      ...(status === "failed" || status === "interrupted" ? { reason: terminalReason(status, error) } : {}),
      leaseRootRunId: this.leaseRunId(),
      finalMessage: persistedFinal,
      ...(isInteractionRoot ? { interactionRootRunId: this.ctx.runId } : {}),
      ...(status === "failed" || status === "interrupted" ? {
        closeDanglingToolCalls: {
          threadKey: this.ctx.threadKey,
          childAgentId: this.ctx.childAgentId ?? null,
          agentName: this.ctx.agentName,
          terminalStatus: status,
          reason: terminalReason(status, error),
        },
      } : {}),
      });

      this.finalMessage = result.finalMessage
        ? { id: result.finalMessage.id, seq: result.finalMessage.seq, contentParts: result.finalMessage.content_parts }
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

  async resolveFinalMessage(): Promise<{ id: string; seq: number; contentParts: MessageContentPart[] } | null> {
    return this.finalMessage;
  }

  private isRootRun(): boolean {
    const rootRunId = this.ctx.rootRunId ?? this.ctx.runId;
    return this.ctx.parentRunId == null && this.ctx.runId === rootRunId;
  }

  private leaseRunId(): string {
    return this.ctx.ownsRunLease ? this.ctx.runId : this.ctx.rootRunId ?? this.ctx.runId;
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
        rootRunId: this.leaseRunId(),
      });
      if (!result.renewed) {
        this.stopLeaseHeartbeat();
        this.leaseLostError = new Error(`run lease was lost: ${this.leaseRunId()}`);
      }
    })();
    try {
      await this.leaseRenewal;
    } finally {
      this.leaseRenewal = null;
    }
  }

  private async persistAssistant(message: ChatMessage, round: number, reasoning?: string): Promise<void> {
    const messageId = `${this.ctx.runId}:intent:${round}`;
    const text = extractText(message.content);
    // 思考是一等持久化内容：随工具轮 INTENT 行落 thinking part（正文 content 不含思考文本）。
    const thinkingPart = reasoning?.trim()
      ? [{ type: "thinking" as const, text: reasoning, round: round + 1, complete: true }]
      : [];
    const input: AddMessageInput & { messageId: string } = {
      messageId,
      sessionId: this.ctx.sessionId,
      role: "assistant",
      contentParts: [...thinkingPart, { type: "text", text }],
      threadKey: this.ctx.threadKey,
      childAgentId: this.ctx.childAgentId ?? null,
      metadata: { ...this.messageMeta(round), msg_type: MSG_TYPE.ROUND },
    };
    if (message.tool_calls) {
      input.toolCalls = message.tool_calls as AddMessageInput["toolCalls"];
    }
    const providerState = this.buildProviderState(message.provider_continuation, message.tool_calls);
    if (providerState) input.providerState = providerState;
    await this.storage.operations.persistMessage({
      leaseRootRunId: this.leaseRunId(),
      message: input,
    });
  }

  /**
   * 隐藏推理状态随消息行落库（含签发者印章 provider_key + model）。
   * 印章用于回放时的换 provider/模型门控：匹配则原样回放，不匹配降级为文本或丢弃。
   * 纯文字轮（无 tool_calls）的 continuation 同样落库——跨 run 全历史回放要求最终轮数据在场。
   */
  private buildProviderState(
    providerContinuation: ChatMessage["provider_continuation"],
    toolCalls?: ChatMessage["tool_calls"],
  ): AddMessageInput["providerState"] | null {
    if (!providerContinuation) return null;
    const callIds = (toolCalls ?? []).map((call) => call.id);
    const stateIds = new Set(providerContinuation.toolCallIds);
    if (callIds.length !== stateIds.size || !callIds.every((id) => stateIds.has(id))) return null;
    if (!this.ctx.providerKey || !this.ctx.model) {
      throw new Error("providerKey and model are required to persist provider state");
    }
    return {
      provider_key: this.ctx.providerKey,
      model: this.ctx.model,
      state: providerContinuation,
    };
  }

  private buildFinalMessage(
    status: RuntimeFinalizeStatus,
    finalMessage: AsyncFinalMessageInput | null,
    error: unknown,
    salvage: AsyncTerminalSalvage | null = null,
  ): (AddMessageInput & { messageId: string }) | null {
    if (status === "completed") {
      if (!finalMessage) throw new Error("completed finalize requires a final message");
      const metadata = {
        ...this.finalMessageMeta(),
        msg_type: MSG_TYPE.ROUND,
        ...(this.ctx.messageMetadata ?? {}),
        ...(finalMessage.metadata ?? {}),
      };
      const finalThinkingPart: MessageContentPart[] = finalMessage.reasoning?.trim()
        ? [{ type: "thinking", text: finalMessage.reasoning, complete: true }]
        : [];
      const finalTextParts: MessageContentPart[] = finalMessage.contentParts
        ? finalMessage.contentParts.flatMap((part): MessageContentPart[] => part.type === "text"
          ? [{ type: "text", text: part.text }]
          : [{
            type: "file_ref",
            file_path: part.filePath,
            presentation: part.presentation,
            ...(part.caption ? { caption: part.caption } : {}),
          }])
        : (finalMessage.content ? [{ type: "text", text: finalMessage.content }] : []);
      const input: AddMessageInput & { messageId: string } = {
        messageId: finalMessage.id?.trim() || `${this.ctx.runId}:final`,
        sessionId: this.ctx.sessionId,
        role: "assistant",
        contentParts: [...finalThinkingPart, ...finalTextParts],
        threadKey: this.ctx.threadKey,
        childAgentId: this.ctx.childAgentId ?? null,
        metadata,
      };
      const providerState = this.buildProviderState(finalMessage.providerContinuation);
      if (providerState) input.providerState = providerState;
      return input;
    }
    if (status !== "failed" && status !== "interrupted") return null;
    return buildTerminalAssistantMessage({
      sessionId: this.ctx.sessionId,
      runId: this.ctx.runId,
      threadKey: this.ctx.threadKey,
      childAgentId: this.ctx.childAgentId ?? null,
      agentName: this.ctx.agentName,
      terminalStatus: status,
      reason: terminalReason(status, error),
      salvage,
      metadata: {
        ...this.finalMessageMeta(),
        ...(this.ctx.messageMetadata ?? {}),
        conversation_scope: this.ctx.parentCallId != null ? "child" : "root",
        ...(this.ctx.taskId ? { task_id: this.ctx.taskId } : {}),
        ...(this.ctx.requestId ? { request_id: this.ctx.requestId } : {}),
        ...(this.ctx.executionKind ? { execution_kind: this.ctx.executionKind } : {}),
      },
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
      conversation_scope: this.ctx.parentCallId != null ? "child" : "root",
      ...(this.boundaryMessageId ? { boundary_message_id: this.boundaryMessageId } : {}),
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
