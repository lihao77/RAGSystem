import type { RunStepInfo } from "../../contracts/common.js";
import { normalizeSessionMetadata, type CreateSessionRecordInput, type MessageInfo, type SessionInfo, type SessionListQuery, type SessionMessageListSnapshot, type SessionTeamSnapshotResolver } from "../../contracts/session/session.js";
import type {
  AgentSessionRepositoryPort,
  AgentSessionRunRecord,
} from "../../contracts/session/agent-session-repository.js";
import type { SessionHistoryPort } from "../../contracts/session/session-history.js";
import { EnvelopeSchema, type Envelope, type MessageContentPart } from "@ragsystem/agent-protocol";
import { EXECUTION_ENVELOPE_STEP_TYPE } from "../runtime/event-outbox/execution-envelope-archive.js";
import type { SessionResourceCleanup } from "../../contracts/session/session-resource-cleanup.js";
import { assertSafeSessionId } from "../../contracts/session/session-id.js";
import type { TenantId } from "../../identity/types.js";
import type { PermissionMode } from "../../contracts/runtime/permissions.js";
import type { ExecutionSessionPort, SessionParticipantRunSummary } from "../../contracts/session/session-application.js";
import { isParticipantConversationMessageVisible } from "../../contracts/session/message-visibility.js";

export class AgentSessionApplication implements ExecutionSessionPort {
  constructor(
    private readonly repository: AgentSessionRepositoryPort,
    private readonly history: SessionHistoryPort | null = null,
    private readonly resourceCleanup: SessionResourceCleanup | null = null,
    private readonly workspaceRootResolver: ((session: SessionInfo) => Promise<string | null>) | null = null,
    private readonly teamSnapshots: SessionTeamSnapshotResolver | null = null,
  ) {}

  async createSession(input: CreateSessionRecordInput): Promise<SessionInfo> {
    assertSafeSessionId(input.sessionId);
    const metadata = normalizeSessionMetadata(input.metadata ?? {});
    await this.repository.createSession({ ...input, metadata });
    const created = await this.repository.getSession(input.sessionId);
    if (!created) throw new Error(`session create returned no row: ${input.sessionId}`);
    return created;
  }

  async createSystemSession(input: {
    tenantId: TenantId;
    sessionId: string;
    metadata?: Record<string, unknown>;
    permissionMode?: PermissionMode | null;
  }): Promise<SessionInfo | null> {
    assertSafeSessionId(input.sessionId);
    const metadata = normalizeSessionMetadata(input.metadata ?? {});
    if (!this.teamSnapshots) throw new Error("Session Team snapshot resolver is not configured");
    await this.repository.createSession({ tenantId: input.tenantId, sessionId: input.sessionId, ownerUserId: "usr_system", visibility: "tenant", originType: "direct", originId: null, originChannel: "api", workspaceId: null, teamSnapshot: this.teamSnapshots.createTeamSnapshot(), metadata, permissionMode: input.permissionMode ?? null });
    return this.repository.getSession(input.sessionId);
  }

  listSessions(input: SessionListQuery) {
    return this.repository.listSessions(input);
  }

  listSessionFacets(input: Pick<SessionListQuery, "tenantId" | "access">) {
    return this.repository.listSessionFacets(input);
  }

  async getSession(sessionId: string): Promise<SessionInfo | null> {
    return this.repository.getSession(sessionId);
  }

  async resolveWorkspaceRoot(sessionId: string): Promise<string | null> {
    const session = await this.getSession(sessionId);
    if (!session?.workspace_id || !this.workspaceRootResolver) return null;
    return this.workspaceRootResolver(session);
  }

  async updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return this.repository.updateSessionMetadata(sessionId, patch);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    await this.history?.cleanup(sessionId);
    const deleted = await this.repository.deleteSession(sessionId);
    if (deleted) await this.resourceCleanup?.cleanupSessionResources(sessionId);
    return deleted;
  }

  async listMessages(input: {
    sessionId: string;
    limit?: number;
    offset?: number;
    threadKey?: string | null;
  }): Promise<SessionMessageListSnapshot> {
    const threadKey = input.threadKey?.trim() || "root";
    const data = await this.repository.listVisibleMessages(input.sessionId, threadKey, input.limit ?? 20, input.offset ?? 0);
    data.items = data.items.map((item) => ({
      ...item,
      has_execution: shouldExposeExecutionCarrier(item) && item.metadata.execution_history_discarded !== true,
    }));
    return data;
  }

  async listMessageRunSteps(input: {
    sessionId: string;
    messageId: string;
    limit?: number;
    offset?: number;
    threadKey?: string | null;
  }): Promise<{ message_id: string; items: Envelope[]; total: number; limit: number; offset: number; has_more: boolean }> {
    const threadKey = input.threadKey?.trim() || "root";
    const message = await this.repository.getMessageById(input.sessionId, input.messageId);
    if (!message || !isParticipantConversationMessageVisible(message, threadKey)) {
      throw new Error(`消息不存在: ${input.messageId}`);
    }
    const limit = input.limit ?? 500;
    const offset = input.offset ?? 0;
    const runId = executionRunId(message);
    const page = runId
      ? await this.repository.listMessageRunSteps({
          sessionId: input.sessionId,
          runId,
          messageId: message.id,
          limit,
          offset,
        })
      : { items: [], total: 0 };
    const envelopes = page.items.map((step) => parseArchivedEnvelope(step.payload));

    return {
      message_id: input.messageId,
      items: envelopes,
      total: page.total,
      limit,
      offset,
      has_more: offset + envelopes.length < page.total,
    };
  }

  async listParticipantRuns(input: {
    sessionId: string;
    participantId: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: SessionParticipantRunSummary[]; total: number; limit: number; offset: number; has_more: boolean }> {
    const limit = input.limit ?? 100;
    const offset = input.offset ?? 0;
    const page = await this.repository.listParticipantRuns(
      input.sessionId,
      input.participantId,
      limit,
      offset,
    );
    return {
      items: page.items.map((run) => ({
        run_id: run.run_id,
        status: run.status,
        task_summary: run.task_summary,
        final_message_id: run.final_message_id,
        created_at: run.created_at,
        updated_at: run.updated_at,
      })),
      total: page.total,
      limit,
      offset,
      has_more: offset + limit < page.total,
    };
  }

  async listParticipantRunExecutionSteps(input: {
    sessionId: string;
    participantId: string;
    runId: string;
    limit?: number;
    offset?: number;
  }): Promise<{ run_id: string; items: Envelope[]; total: number; limit: number; offset: number; has_more: boolean }> {
    const limit = input.limit ?? 500;
    const offset = input.offset ?? 0;
    const run = await this.repository.getRun(input.sessionId, input.runId);
    if (!run || !this.isParticipantRun(run, input.participantId)) {
      throw new Error(`Run 不存在: ${input.runId}`);
    }
    const envelopes = await this.collectRunExecutionEnvelopes(input.sessionId, input.runId);
    return {
      run_id: input.runId,
      items: envelopes.slice(offset, offset + limit),
      total: envelopes.length,
      limit,
      offset,
      has_more: offset + limit < envelopes.length,
    };
  }

  private isParticipantRun(run: AgentSessionRunRecord, participantId: string): boolean {
    return participantId === "root"
      ? run.child_agent_id == null && run.thread_key === "root"
      : run.child_agent_id === participantId;
  }

  /**
   * 读取单个 Run 的持久化 Envelope。父子 Run 的关系只用于运行时生命周期，
   * 不参与会话执行过程展示。
   */
  private async collectRunExecutionEnvelopes(
    sessionId: string,
    runId: string,
  ): Promise<Envelope[]> {
    const steps = await this.listRunStepsAll({
      runId,
      sessionId,
    });
    const archived = steps
      .filter((step) => step.step_type === EXECUTION_ENVELOPE_STEP_TYPE)
      .map((step) => parseArchivedEnvelope(step.payload));
    return archived;
  }

  private async listRunStepsAll(input: {
    runId?: string | null;
    sessionId?: string | null;
  }): Promise<RunStepInfo[]> {
    const pageSize = 500;
    const steps: RunStepInfo[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.repository.listRunSteps({ ...input, limit: pageSize, offset });
      steps.push(...page);
      if (page.length < pageSize) return steps;
    }
  }

  async addMessage(input: {
    sessionId: string;
    role: MessageInfo["role"];
    content: string;
    contentParts: MessageContentPart[];
    metadata?: Record<string, unknown>;
    toolCalls?: MessageInfo["tool_calls"];
    toolCallId?: string | undefined;
    name?: string | undefined;
    messageId?: string;
    threadKey?: string;
    childAgentId?: string | null;
  }): Promise<MessageInfo> {
    const message = await this.repository.addMessage(input);
    if ((message.role === "user" && isVisibleRootMessage(message)) || message.role === "assistant") {
      const snapshotId = await this.history?.makeSnapshot(input.sessionId, message.seq);
      if (snapshotId) {
        const metadata = {
          ...message.metadata,
          snapshot_id: snapshotId,
        };
        await this.repository.updateMessage({
          messageId: message.id,
          metadata,
          sessionId: input.sessionId,
          roleFilter: message.role,
        });
        return {
          ...message,
          metadata,
        };
      }
    }
    return message;
  }

  async getLastRunRound(sessionId: string, runId: string): Promise<number> {
    return (await this.repository.listRunSteps({ sessionId, runId, limit: 1000 }))
      .reduce((max, step) => {
        if (step.step_type !== EXECUTION_ENVELOPE_STEP_TYPE) return max;
        const payload = step.payload.payload;
        const round = payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).round
          : undefined;
        return typeof round === "number" && round > max ? round : max;
      }, 0);
  }

  async updateUserMessage(input: { sessionId: string; messageId: string; content: string }): Promise<boolean> {
    return this.repository.updateMessage({
      messageId: input.messageId,
      content: input.content,
      contentParts: input.content ? [{ type: "text", text: input.content }] : [],
      sessionId: input.sessionId,
      roleFilter: "user",
    });
  }

  async getMessageForRetry(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Promise<MessageInfo | null> {
    return this.resolveRetryAnchor(input.sessionId, input.afterSeq, input.afterMessageId);
  }

  async rollbackMessages(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Promise<number> {
    const payload: { afterSeq?: number | null; afterMessageId?: string | null } = {};
    if (input.afterSeq !== undefined) {
      payload.afterSeq = input.afterSeq;
    }
    if (input.afterMessageId !== undefined) {
      payload.afterMessageId = input.afterMessageId;
    }
    await this.rollbackFileSnapshot(input.sessionId, input.afterSeq, input.afterMessageId);
    const truncateRunSteps = await this.resolveRollbackRunStepTruncation(
      input.sessionId,
      input.afterSeq,
      input.afterMessageId,
    );
    return this.repository.deleteMessagesAfter(input.sessionId, {
      ...payload,
      ...(truncateRunSteps ? { truncateRunSteps } : {}),
    });
  }

  private async resolveRollbackRunStepTruncation(
    sessionId: string,
    afterSeq?: number | null,
    afterMessageId?: string | null,
  ): Promise<{ runId: string; fromStepOrder: number } | null> {
    let boundarySeq = afterSeq ?? null;
    if (boundarySeq == null && afterMessageId?.trim()) {
      boundarySeq = (await this.repository.getMessageById(sessionId, afterMessageId.trim()))?.seq ?? null;
    }
    if (boundarySeq == null) return null;
    const firstDeleted = await this.repository.getFirstMessageAfterSeq(sessionId, boundarySeq);
    if (!firstDeleted || !isRunFollowupMessage(firstDeleted)) return null;
    const runId = executionRunId(firstDeleted);
    if (!runId) return null;
    const boundaryStepOrder = await this.repository.getRunMessageBoundary(
      sessionId,
      runId,
      firstDeleted.id,
    );
    return boundaryStepOrder == null ? null : { runId, fromStepOrder: boundaryStepOrder };
  }

  async exportSession(sessionId: string): Promise<{
    version: number;
    exported_at: string;
    session: SessionInfo;
    messages: Array<MessageInfo & { execution_events?: Envelope[] }>;
    message_count: number;
  }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    let messages = await this.listMessages({
      sessionId,
      limit: 1000,
      offset: 0,
    });
    if (messages.has_more) {
      messages = await this.listMessages({
        sessionId,
        limit: Math.max(messages.total, 1000),
        offset: 0,
      });
    }
    const exportedMessages: Array<MessageInfo & { execution_events?: Envelope[] }> = [];
    for (const message of messages.items) {
      if (message.role !== "assistant" || !message.metadata.run_id) {
        exportedMessages.push(message);
        continue;
      }
      exportedMessages.push({
        ...message,
        execution_events: await this.collectRunExecutionEnvelopes(
          sessionId,
          String(message.metadata.run_id),
        ),
      });
    }
    return {
      version: 2,
      exported_at: new Date().toISOString(),
      session,
      messages: exportedMessages,
      message_count: exportedMessages.length,
    };
  }

  private async resolveRetryAnchor(
    sessionId: string,
    afterSeq?: number | null,
    afterMessageId?: string | null,
  ): Promise<MessageInfo | null> {
    if (afterSeq !== undefined && afterSeq !== null) {
      return this.repository.getMessageBySeq(sessionId, afterSeq);
    }
    const messageId = afterMessageId?.trim();
    if (!messageId) {
      return null;
    }
    return this.repository.getMessageById(sessionId, messageId);
  }

  private async rollbackFileSnapshot(
    sessionId: string,
    afterSeq?: number | null,
    afterMessageId?: string | null,
  ): Promise<void> {
    if (!this.history || !await this.history.hasSnapshots(sessionId)) {
      return;
    }
    const anchor = await this.resolveSnapshotAnchorUserMessage(sessionId, afterSeq, afterMessageId);
    if (!anchor) {
      return;
    }
    await this.history.rewind(sessionId, anchor.seq);
  }

  private async resolveSnapshotAnchorUserMessage(
    sessionId: string,
    afterSeq?: number | null,
    afterMessageId?: string | null,
  ): Promise<MessageInfo | null> {
    let targetMessage: MessageInfo | null = null;
    if (afterSeq !== undefined && afterSeq !== null) {
      targetMessage = await this.repository.getMessageBySeq(sessionId, afterSeq);
    } else {
      const messageId = afterMessageId?.trim();
      if (messageId) {
        targetMessage = await this.repository.getMessageById(sessionId, messageId);
      }
    }

    if (!targetMessage && afterSeq !== undefined && afterSeq !== null) {
      targetMessage = await this.repository.getFirstMessageAfterSeq(sessionId, afterSeq);
    }
    if (!targetMessage) {
      return null;
    }
    if (targetMessage.role === "user" && isVisibleRootMessage(targetMessage)) {
      return targetMessage;
    }

    const nextUser = (await this.repository.listMessagesAfterSeq(sessionId, targetMessage.seq, 20))
      .find((message) => message.role === "user" && isVisibleRootMessage(message));
    if (nextUser) {
      return nextUser;
    }
    return (await this.repository.listMessagesBeforeOrAtSeq(sessionId, targetMessage.seq, 20))
      .find((message) => message.role === "user" && isVisibleRootMessage(message)) ?? null;
  }
}

function isVisibleRootMessage(item: MessageInfo): boolean {
  return isParticipantConversationMessageVisible(item, "root");
}

function isVisibleParticipantMessage(item: MessageInfo, threadKey: string): boolean {
  return isParticipantConversationMessageVisible(item, threadKey);
}

function executionRunId(message: Pick<MessageInfo, "metadata">): string | null {
  const metadata = message.metadata ?? {};
  const runId = metadata.consumed_by_run_id ?? metadata.run_id;
  return typeof runId === "string" && runId.trim() ? runId : null;
}

function shouldExposeExecutionCarrier(message: MessageInfo): boolean {
  return (message.role === "user" || message.role === "assistant")
    && executionRunId(message) != null;
}

function isRunFollowupMessage(message: MessageInfo): boolean {
  return message.role === "user"
    && (message.metadata.source === "running_session"
      || message.metadata.execution_kind === "session_followup");
}

function parseArchivedEnvelope(payload: Record<string, unknown>): Envelope {
  return EnvelopeSchema.parse(payload) as Envelope;
}
