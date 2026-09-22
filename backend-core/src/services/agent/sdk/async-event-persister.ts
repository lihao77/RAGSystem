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
import type { AgentMailboxInputType, AgentMailboxMessageKind, AgentMailboxSourceKind } from "../../../contracts/storage/agent-mailbox-repository.js";
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
import type { GoalPauseNotice } from "../../../contracts/runtime/goals.js";

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
    sentAt: string | null;
    contentParts: MessageContentPart[];
    metadata?: Record<string, unknown> | null;
    kind?: AgentMailboxMessageKind;
    targetThreadKey?: string;
    targetRunId?: string | null;
    targetAgentCallId?: string | null;
    targetChildAgentId?: string | null;
    sourceRunId?: string | null;
    sourceAgentCallId?: string | null;
    correlationId?: string | null;
    replyToMessageId?: string | null;
  };
  initialMessage?: AddMessageInput & { messageId: string };
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
  pausedGoal?: GoalPauseNotice;
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
  /** 连续续期异常计数：瞬时不置闩，连续失败（≈40s，仍在 TTL 60s 余量内）才判定丢租。 */
  private leaseRenewalFailures = 0;
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
    const agentMessage = this.initialAgentMessageEnvelope();
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
      ...(agentMessage
        ? [prepareInitial(agentMessage, `${this.ctx.runId}:initial:agent_message`)]
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
      ...(this.ctx.childAgentId ? {
        participantRun: { childAgentId: this.ctx.childAgentId },
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
            // 透传认领行完整身份：kind/寻址/关联字段缺省值与 run-engine 合成信封一致，
            // 引用既有行时逐字段回传，保证闸门重建 enqueue 过 sameMessageIdentity。
            targetThreadKey: this.ctx.rootMailboxMessage.targetThreadKey ?? "root",
            kind: this.ctx.rootMailboxMessage.kind ?? "request",
            inputType: this.ctx.rootMailboxMessage.inputType,
            sourceKind: this.ctx.rootMailboxMessage.sourceKind,
            visibleToUser: this.ctx.rootMailboxMessage.visibleToUser,
            sentAt: this.ctx.rootMailboxMessage.sentAt,
            contentParts: this.ctx.rootMailboxMessage.contentParts,
            metadata: this.ctx.rootMailboxMessage.metadata ?? {},
            targetRunId: this.ctx.rootMailboxMessage.targetRunId ?? null,
            targetAgentCallId: this.ctx.rootMailboxMessage.targetAgentCallId ?? null,
            targetChildAgentId: this.ctx.rootMailboxMessage.targetChildAgentId ?? null,
            sourceRunId: this.ctx.rootMailboxMessage.sourceRunId ?? null,
            sourceAgentCallId: this.ctx.rootMailboxMessage.sourceAgentCallId ?? null,
            correlationId: this.ctx.rootMailboxMessage.correlationId ?? null,
            replyToMessageId: this.ctx.rootMailboxMessage.replyToMessageId ?? null,
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
    if (this.ctx.parentRunId == null) return this.rootInitialMessageSavedEnvelope();
    return this.childInitialMessageSavedEnvelope();
  }

  private rootInitialMessageSavedEnvelope(): Envelope | null {
    if (!this.ctx.rootMailboxMessage) return null;
    const mailbox = this.ctx.rootMailboxMessage;
    const canonical = rootMailboxConversationMessage({
      sessionId: this.ctx.sessionId,
      runId: this.ctx.runId,
      mailboxMessage: {
        messageId: mailbox.id,
        tenantId: this.ctx.tenantId,
        sessionId: this.ctx.sessionId,
        targetThreadKey: mailbox.targetThreadKey ?? "root",
        kind: mailbox.kind ?? "request",
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

  /**
   * 子 run 的初始用户行（委派任务的合成指令）随启动事务落库，不走认领/邮箱投递，wire 上
   * 本来毫无播报——而子线程的一切都以这行为边界：输入气泡靠它渲染，执行帧靠它挂载
   * （前端在边界到达前只能把帧挂在待投队列里），所以缺了它，实时视图只剩最终答案，
   * 要等切换重载才补齐。
   *
   * agent_message/mailbox 语义的初始消息（父消息直启 / 续接）由 initialAgentMessageEnvelope
   * 以 agent_message 承接，这里跳过以免同一行被播报两次；其余（合成指令）补一条 message_saved
   * 用户 ref：与 root 首发同形，前端按顶层 participant_id 落进参与者线程，与重载渲染口径一致
   * （普通 user 气泡，而非智能体气泡）。
   */
  private childInitialMessageSavedEnvelope(): Envelope | null {
    const initial = this.ctx.initialMessage;
    const childAgentId = this.ctx.childAgentId;
    if (!initial || childAgentId == null) return null;
    const metadata = initial.metadata ?? {};
    if (metadata.agent_message === true || typeof metadata.mailbox_message_id === "string") return null;
    return {
      type: "state_sync",
      session_id: this.ctx.sessionId,
      run_id: this.ctx.runId,
      participant_id: childAgentId,
      boundary_message_id: initial.messageId,
      payload: {
        category: "message_saved",
        ref: {
          message_id: initial.messageId,
          role: "user",
          request_id: typeof metadata.request_id === "string" ? metadata.request_id : undefined,
          content_parts: initial.contentParts ?? [],
          metadata,
        },
      },
    };
  }

  /**
   * Child run 随启动事务携带的初始消息（父消息直启新 run / mailbox 续接 run）不经
   * 运行中认领路径，wire 侧没有任何"新消息"事件——实时查看子线程时父消息要等切
   * 换重载才可见。这里按认领路径（event-publisher.buildAgentMessage + runtime-adapter
   * 的 canonicalMetadata）的同形 payload 补一条 agent_message 初始 Envelope，前端
   * useMessageExecution 会据 target_child_agent_id 实时插入子线程。仅限 agent/mailbox
   * 语义的初始消息：委派任务的合成指令不在此列（与重载渲染口径一致，非 agent_message
   * 不渲染为智能体气泡），它由 childInitialMessageSavedEnvelope 以 message_saved 用户
   * ref 播报——同样落进子线程，但渲染的是普通 user 气泡。
   */
  private initialAgentMessageEnvelope(): Envelope | null {
    if (this.ctx.childAgentId == null || !this.ctx.initialMessage) return null;
    const initial = this.ctx.initialMessage;
    const metadata = initial.metadata ?? {};
    if (metadata.agent_message !== true && typeof metadata.mailbox_message_id !== "string") return null;
    const consumedRunId = typeof metadata.consumed_by_run_id === "string"
      ? metadata.consumed_by_run_id
      : this.ctx.runId;
    const contentParts = initial.contentParts ?? [];
    const textContent = contentParts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
    const content = typeof metadata.agent_message_display_content === "string" && metadata.agent_message_display_content
      ? metadata.agent_message_display_content
      : textContent;
    const kind = metadata.mailbox_kind === "progress"
      || metadata.mailbox_kind === "response"
      || metadata.mailbox_kind === "result"
      ? metadata.mailbox_kind
      : "request";
    const direction = metadata.direction === "parent_to_child" || metadata.direction === "child_to_parent"
      ? metadata.direction
      : null;
    const sourceAgentName = typeof metadata.source_agent_name === "string"
      ? metadata.source_agent_name
      : null;
    const sourceChildAgentId = typeof metadata.source_child_agent_id === "string"
      ? metadata.source_child_agent_id
      : typeof metadata.child_agent_id === "string"
        ? metadata.child_agent_id
        : null;
    const sourceRunId = typeof metadata.mailbox_source_run_id === "string"
      ? metadata.mailbox_source_run_id
      : typeof metadata.source_run_id === "string"
        ? metadata.source_run_id
        : null;
    const sourceAgentCallId = typeof metadata.mailbox_source_agent_call_id === "string"
      ? metadata.mailbox_source_agent_call_id
      : null;
    return {
      type: "agent_message",
      session_id: this.ctx.sessionId,
      run_id: this.ctx.runId,
      call_id: this.ctx.rootCallId,
      message_id: initial.messageId,
      payload: {
        kind,
        message_id: initial.messageId,
        source_run_id: sourceRunId,
        source_agent_call_id: sourceAgentCallId,
        ...(sourceAgentName ? { source_agent_name: sourceAgentName } : {}),
        source_child_agent_id: sourceChildAgentId,
        target_child_agent_id: this.ctx.childAgentId,
        target_thread_key: this.ctx.threadKey,
        ...(direction ? { direction } : {}),
        correlation_id: typeof metadata.mailbox_correlation_id === "string"
          ? metadata.mailbox_correlation_id
          : null,
        reply_to_message_id: typeof metadata.mailbox_reply_to_message_id === "string"
          ? metadata.mailbox_reply_to_message_id
          : null,
        content,
        content_parts: contentParts,
        metadata: {
          ...metadata,
          consumed_by_run_id: consumedRunId,
          run_id: consumedRunId,
        },
      },
    };
  }

  async persist(event: KernelEvent): Promise<void> {
    // 租约续期由 20s 心跳与终局 ensureRunLease 承担；逐事件续期会让 SaaS 每个流式
    // 事件多一次 DB 写。这里只做失败闩的零成本检查——心跳一旦判定丢租约，下一事件即失败。
    this.throwIfLeaseLost();
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
      // 任意终局（含 interrupted/failed）都提交文件快照边界：pending 只允许承载"运行中 run"的编辑。
      // 只在 completed 关窗时，被停止/失败的 run 的编辑会无限期悬在 pending，之后任何一次无关锚点的
      // 回退都会把它们冲掉（消息口径保留、文件口径被抹的不对称事故）。
      if (result.finalMessage) {
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
    this.throwIfLeaseLost();
    await this.renewRunLease();
    this.throwIfLeaseLost();
  }

  private throwIfLeaseLost(): void {
    if (this.leaseLostError) throw this.leaseLostError;
  }

  private async renewRunLease(): Promise<void> {
    if (!this.storage.operations.renewRunLease) return;
    if (this.leaseRenewal) return this.leaseRenewal;
    this.leaseRenewal = (async () => {
      try {
        const result = await this.storage.operations.renewRunLease!({
          sessionId: this.ctx.sessionId,
          rootRunId: this.leaseRunId(),
        });
        this.leaseRenewalFailures = 0;
        if (!result.renewed) {
          this.stopLeaseHeartbeat();
          this.leaseLostError = new Error(`run lease was lost: ${this.leaseRunId()}`);
        }
      } catch (error) {
        // 续期抛错（网络分区/池耗尽）不等于丢租，但连续失败说明租约实际已无法维持——
        // 置闩让后续事件 fail-fast，把脑裂窗口收束到一个心跳周期内。
        this.leaseRenewalFailures += 1;
        if (this.leaseRenewalFailures >= 2) {
          this.stopLeaseHeartbeat();
          this.leaseLostError = error instanceof Error
            ? error
            : new Error(`run lease renewal failed: ${this.leaseRunId()}`);
        }
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
