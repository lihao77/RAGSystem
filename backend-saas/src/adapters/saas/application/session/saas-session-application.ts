import type { AsyncConversationRepository, AsyncMessageFeedbackStore, AsyncRunStore, ExecutionReplayRepositoryPort } from "@ragsystem/backend-core/contracts/storage/async-persistence-ports.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { PermissionMode } from "@ragsystem/backend-core/contracts/runtime/permissions.js";
import type { MessageFeedbackValue } from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import { isParticipantConversationMessageVisible } from "@ragsystem/backend-core/contracts/session/message-visibility.js";
import { stripPrivateMessageFields } from "@ragsystem/backend-core/services/sessions/index.js";
import { synthesizeExecutionEnvelopes } from "@ragsystem/backend-core/services/sessions/execution-synthesis.js";
import type { CreateSessionRecordInput, MessageInfo, SessionCreateInput, SessionIdentity, SessionInfo, SessionMessageListSnapshot, SessionTeamSnapshotResolver } from "@ragsystem/backend-core/contracts/session/session.js";
import { normalizeSessionMetadata } from "@ragsystem/backend-core/contracts/session/session.js";
import { assertSafeSessionId } from "@ragsystem/backend-core/contracts/session/session-id.js";
import type { AsyncFileHistoryStore } from "@ragsystem/backend-core/contracts/file-history-store/index.js";
import type { EntityLifecycleBinding } from "@ragsystem/backend-core/contracts/runtime/entity-lifecycle-events.js";
import { SESSION_DELETED_EVENT } from "@ragsystem/backend-core/contracts/runtime/entity-lifecycle-events.js";
import type { RunInfo } from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import { EnvelopeSchema, type Envelope } from "@ragsystem/agent-protocol";
import { TenantSessionIdentityApplication } from "@ragsystem/backend-core/services/sessions/session-identity-application.js";
import type { ExecutionSessionPort, SessionApplication, SessionParticipantRunSummary } from "@ragsystem/backend-core/contracts/session/session-application.js";
import type { WorkspaceRepositoryPort } from "@ragsystem/backend-core/contracts/workspace/workspace-repository.js";

export class SaaSSessionApplication implements SessionApplication, ExecutionSessionPort {
  private readonly sessionIdentities: TenantSessionIdentityApplication;

  constructor(
    private readonly tenantId: TenantId,
    private readonly repository: AsyncConversationRepository,
    private readonly teamSnapshots: SessionTeamSnapshotResolver,
    private readonly fileHistory: AsyncFileHistoryStore | null = null,
    private readonly runs: AsyncRunStore | null = null,
    _outbox: ExecutionReplayRepositoryPort | null = null,
    private readonly workspaces: WorkspaceRepositoryPort | null = null,
    private readonly lifecycle: EntityLifecycleBinding | null = null,
    private readonly messageFeedback: AsyncMessageFeedbackStore | null = null,
  ) {
    this.sessionIdentities = new TenantSessionIdentityApplication(tenantId, {
      getSession: (sessionId) => repository.getSession(sessionId),
      createSession: (input) => repository.createSession(input),
      updateSessionMetadata: (sessionId, patch) => repository.updateSessionMetadata(sessionId, patch),
    });
  }
  ensureSession(input: Parameters<SessionApplication["ensureSession"]>[0]) {
    return this.sessionIdentities.ensureSession(input);
  }
  async createSession(input: SessionCreateInput): Promise<SessionInfo> {
    assertSafeSessionId(input.sessionId);
    const metadata = normalizeSessionMetadata(input.metadata ?? {});
    const { teamName, entryAgentName, ...identity } = input;
    const record: CreateSessionRecordInput = {
      ...identity,
      tenantId: this.tenantId,
      metadata,
      teamSnapshot: this.teamSnapshots.createTeamSnapshot({ teamName, entryAgentName }),
    };
    await this.repository.createSession(record);
    const created = await this.getSession(input.sessionId);
    if (!created) throw new Error(`session create returned no row: ${input.sessionId}`);
    return created;
  }
  async createSystemSession(input: { sessionId: string; metadata?: Record<string, unknown>; permissionMode?: PermissionMode | null }) {
    assertSafeSessionId(input.sessionId);
    const metadata = normalizeSessionMetadata(input.metadata ?? {});
    await this.repository.createSession({
      tenantId: this.tenantId,
      sessionId: input.sessionId,
      ownerUserId: "usr_system",
      visibility: "tenant",
      originType: "direct",
      originId: null,
      originChannel: "api",
      workspaceId: null,
      teamSnapshot: this.teamSnapshots.createTeamSnapshot(),
      metadata,
      permissionMode: input.permissionMode ?? null,
    });
    return this.getSession(input.sessionId);
  }
  listSessions(input: Omit<import("@ragsystem/backend-core/contracts/session/session.js").SessionListQuery, "tenantId">) {
    return this.repository.listSessions({ ...input, tenantId: this.tenantId });
  }
  listSessionFacets(input: Pick<import("@ragsystem/backend-core/contracts/session/session.js").SessionListQuery, "access">) {
    return this.repository.listSessionFacets({ ...input, tenantId: this.tenantId });
  }
  listWorkspacesByIds(workspaceIds: readonly string[]) {
    return this.workspaces?.listByIds(this.tenantId, workspaceIds) ?? Promise.resolve([]);
  }
  listWorkspaces() {
    return this.workspaces?.listAll(this.tenantId) ?? Promise.resolve([]);
  }
  removeWorkspace(workspaceId: string) {
    return this.workspaces?.remove(this.tenantId, workspaceId) ?? Promise.resolve(false);
  }
  async resolveWorkspace(input: { kind: "local_path"; root_path: string } | { kind: "existing"; workspace_id: string } | null | undefined): Promise<string | null> {
    if (!input) return null;
    if (input.kind === "local_path") throw new Error("SaaS 不支持服务器本地路径 Workspace");
    const workspace = await this.workspaces?.getById(this.tenantId, input.workspace_id);
    if (!workspace || workspace.removed_at) throw new Error("Workspace 不存在或已移除");
    return workspace.workspace_id;
  }
  async getSession(sessionId: string): Promise<SessionInfo | null> { const row = await this.repository.getSession(sessionId); return row?.tenant_id === this.tenantId ? row : null; }
  async resolveWorkspaceRoot(sessionId: string): Promise<string | null> {
    const session = await this.getSession(sessionId);
    if (!session?.workspace_id) return null;
    return (await this.workspaces?.getById(this.tenantId, session.workspace_id))?.root_path ?? null;
  }
  /** Returns the raw row so route ownership validation can reject a cross-tenant session id. */
  getSessionForExecutionValidation(sessionId: string): Promise<SessionInfo | null> { return this.repository.getSession(sessionId); }
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>) { return this.sessionIdentities.updateSessionMetadata(sessionId, patch); }
  async updateSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean> { return (await this.getSession(sessionId)) ? this.repository.updateSessionPermissionMode(sessionId, mode) : false; }
  async deleteSession(sessionId: string): Promise<boolean> {
    if (!(await this.getSession(sessionId))) return false;
    await this.fileHistory?.cleanup(sessionId);
    const deleted = await this.repository.deleteSession(sessionId);
    if (deleted && this.lifecycle) {
      await this.lifecycle.publish(SESSION_DELETED_EVENT, {
        tenantId: this.tenantId,
        sessionId,
      });
    }
    return deleted;
  }
  async listMessages(input: { sessionId: string; limit?: number; offset?: number; threadKey?: string | null }): Promise<SessionMessageListSnapshot | null> {
    if (!(await this.getSession(input.sessionId))) return null;
    const threadKey = input.threadKey?.trim() || "root";
    const data = await this.repository.listVisibleMessagesSnapshot(
      this.tenantId,
      input.sessionId,
      threadKey,
      input.limit ?? 20,
      input.offset ?? 0,
    );
    data.items = data.items.map((item) => ({
      ...stripPrivateMessageFields(item),
      has_execution: shouldExposeExecutionCarrier(item) && item.metadata.execution_history_discarded !== true,
    }));
    return data;
  }
  async exportSession(sessionId: string): Promise<{ version: number; exported_at: string; session: SessionInfo; messages: MessageInfo[]; message_count: number }> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    let page = await this.listMessages({ sessionId, limit: 1000, offset: 0 });
    if (!page) throw new Error(`会话不存在: ${sessionId}`);
    if (page.has_more) page = await this.listMessages({ sessionId, limit: Math.max(page.total, 1000), offset: 0 }) ?? page;
    return { version: 2, exported_at: new Date().toISOString(), session, messages: page.items, message_count: page.items.length };
  }
  async getRecentMessages(sessionId: string, limit = 10_000, threadKey?: string | null): Promise<MessageInfo[]> {
    if (!(await this.getSession(sessionId))) return [];
    return this.repository.getRecentMessages(sessionId, limit, threadKey ?? "root");
  }
  async getMessageForRetry(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Promise<MessageInfo | null> {
    if (!(await this.getSession(input.sessionId))) return null;
    return input.afterSeq != null
      ? this.repository.getMessageBySeq(input.sessionId, input.afterSeq)
      : input.afterMessageId ? this.repository.getMessageById(input.sessionId, input.afterMessageId) : null;
  }
  async addMessage(input: Parameters<AsyncConversationRepository["addMessage"]>[0]): Promise<MessageInfo> {
    if (!(await this.getSession(input.sessionId))) {
      throw new Error(`会话不存在: ${input.sessionId}`);
    }
    const message = await this.repository.addMessage(input);
    if ((message.role === "user" && isVisibleRootMessage(message)) || message.role === "assistant") {
      const snapshotId = await this.fileHistory?.makeSnapshot(input.sessionId, message.seq);
      if (snapshotId) {
        const metadata = { ...message.metadata, snapshot_id: snapshotId };
        await this.repository.updateMessage({
          messageId: message.id,
          metadata,
          sessionId: input.sessionId,
          roleFilter: message.role,
        });
        return { ...message, metadata };
      }
    }
    return message;
  }
  /** 执行视图（消息行合成）：从本 run 的消息行重建执行树 envelope 流（思考=thinking part）。 */
  async listMessageExecution(input: { sessionId: string; messageId: string; threadKey?: string | null }): Promise<{ message_id: string; items: Envelope[]; total: number }> {
    if (!(await this.getSession(input.sessionId))) {
      throw new Error(`会话不存在: ${input.sessionId}`);
    }
    const threadKey = input.threadKey?.trim() || "root";
    const message = await this.repository.getMessageById(input.sessionId, input.messageId);
    if (!message || !isParticipantConversationMessageVisible(message, threadKey)) {
      throw new Error(`消息不存在: ${input.messageId}`);
    }
    const runId = executionRunId(message);
    if (!runId) return { message_id: input.messageId, items: [], total: 0 };
    // 分段只对 user 边界行生效（每个用户行一个面板段）；assistant 行问的是整 run 视图。
    const items = await this.synthesizeRunEnvelopes(
      input.sessionId,
      runId,
      threadKey,
      message.role === "user" ? message.id : undefined,
    );
    return { message_id: input.messageId, items, total: items.length };
  }

  /**
   * 拉取一个 run 的消息行并合成执行 envelope。boundaryMessageId 存在时按段分割：
   * 插嘴被同 run 认领后消息表有多个用户行，每个用户行只回放自己段内的行
   * （行上 boundary_message_id 盖章；无标记旧行按 seq 归属最近前置用户行）。
   */
  private async synthesizeRunEnvelopes(
    sessionId: string,
    runId: string,
    threadKey: string,
    boundaryMessageId?: string,
  ): Promise<Envelope[]> {
    const page = await this.repository.listMessages(sessionId, 10_000, 0, threadKey);
    const runRows = page.items
      .filter((row) => row.metadata?.run_id === runId)
      .sort((a, b) => a.seq - b.seq);
    if (!boundaryMessageId) return synthesizeExecutionEnvelopes(runRows, { sessionId, runId });
    const userRows = runRows.filter((row) => row.role === "user");
    const segmentRows = runRows.filter((row) => {
      const marker = row.metadata?.boundary_message_id;
      if (typeof marker === "string" && marker) return marker === boundaryMessageId;
      let owner: string | null = userRows[0]?.id ?? null;
      for (const userRow of userRows) {
        if (userRow.seq <= row.seq) owner = userRow.id;
        else break;
      }
      return owner === boundaryMessageId;
    });
    return synthesizeExecutionEnvelopes(segmentRows, { sessionId, runId });
  }

  async listParticipantRuns(input: {
    sessionId: string;
    participantId: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: SessionParticipantRunSummary[]; total: number; limit: number; offset: number; has_more: boolean }> {
    if (!(await this.getSession(input.sessionId))) {
      throw new Error(`会话不存在: ${input.sessionId}`);
    }
    if (!this.runs) throw new Error("SaaS run repository 未配置");
    const limit = input.limit ?? 100;
    const offset = input.offset ?? 0;
    const page = await this.runs.listParticipantRuns(
      this.tenantId,
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
    if (!(await this.getSession(input.sessionId))) {
      throw new Error(`会话不存在: ${input.sessionId}`);
    }
    if (!this.runs) throw new Error("SaaS run repository 未配置");
    const run = await this.runs.getRun(this.tenantId, input.sessionId, input.runId);
    if (!run || !isParticipantRun(run, input.participantId)) {
      throw new Error(`Run 不存在: ${input.runId}`);
    }
    const limit = input.limit ?? 500;
    const offset = input.offset ?? 0;
    // 同源改造：participant 执行视图同样来自该 run 所属线程的消息行合成。
    const envelopes = await this.synthesizeRunEnvelopes(
      input.sessionId,
      input.runId,
      run.thread_key || "root",
    );
    return {
      run_id: input.runId,
      items: envelopes.slice(offset, offset + limit),
      total: envelopes.length,
      limit,
      offset,
      has_more: offset + limit < envelopes.length,
    };
  }

  async updateUserMessage(input: { sessionId: string; messageId: string; content: string }): Promise<boolean> { if (!(await this.getSession(input.sessionId))) return false; return this.repository.updateMessage({ sessionId: input.sessionId, messageId: input.messageId, contentParts: input.content ? [{ type: "text", text: input.content }] : [], roleFilter: "user" }); }
  async setMessageFeedback(input: { sessionId: string; messageId: string; value: MessageFeedbackValue; comment?: string | null; userId?: string | null }) {
    if (!this.messageFeedback) return null;
    // 仅助手消息可评价：先验消息存在与角色，不可评价统一返回 null（路由层映射 404）。
    const message = await this.repository.getMessageById(input.sessionId, input.messageId);
    if (!message || message.role !== "assistant") return null;
    return this.messageFeedback.setMessageFeedback({
      sessionId: input.sessionId,
      messageId: input.messageId,
      tenantId: this.tenantId,
      value: input.value,
      comment: input.comment ?? null,
      userId: input.userId ?? null,
    });
  }
  async clearMessageFeedback(input: { sessionId: string; messageId: string }): Promise<boolean> {
    if (!this.messageFeedback) return false;
    return this.messageFeedback.clearMessageFeedback(input);
  }
  async listMessageFeedback(sessionId: string) {
    if (!this.messageFeedback) return [];
    return this.messageFeedback.listMessageFeedback(sessionId);
  }
  async listNegativeMessageFeedback(input?: { since?: string; limit?: number }) {
    if (!this.messageFeedback) return [];
    return this.messageFeedback.listNegativeMessageFeedback(this.tenantId, input);
  }
  async listRuns(sessionId: string, limit?: number) {
    if (!this.runs) return [];
    const page = await this.runs.listRuns(this.tenantId, sessionId, limit ?? 50);
    return page.items;
  }
  async rollbackMessages(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Promise<number> {
    if (!(await this.getSession(input.sessionId))) return 0;
    const fileHistory = this.fileHistory;
    if (fileHistory) {
      let targetSeq = input.afterSeq ?? null;
      if (targetSeq == null && input.afterMessageId) {
        targetSeq = (await this.repository.getMessageById(input.sessionId, input.afterMessageId))?.seq ?? null;
      }
      if (targetSeq != null && await fileHistory.hasSnapshots(input.sessionId)) {
        await fileHistory.rewind(input.sessionId, targetSeq);
      }
    }
    return this.repository.deleteMessagesAfter(input.sessionId, {
      afterSeq: input.afterSeq ?? null,
      afterMessageId: input.afterMessageId ?? null,
      tenantId: this.tenantId,
    });
  }
}

function isVisibleRootMessage(message: MessageInfo): boolean {
  return isParticipantConversationMessageVisible(message, "root");
}

function isVisibleParticipantMessage(message: MessageInfo, threadKey: string): boolean {
  return isParticipantConversationMessageVisible(message, threadKey);
}

function isParticipantRun(run: RunInfo, participantId: string): boolean {
  return participantId === "root"
    ? run.child_agent_id == null && run.thread_key === "root"
    : run.child_agent_id === participantId;
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


interface StoredExecutionEnvelope {
  eventId: string | null;
  envelope: Envelope;
}

function mergeExecutionEnvelopes(
  archived: StoredExecutionEnvelope[],
  durable: StoredExecutionEnvelope[],
): Envelope[] {
  const merged: StoredExecutionEnvelope[] = [];
  const indexByEventId = new Map<string, number>();
  const fallbackKeys = new Map<string, number>();
  const append = (record: StoredExecutionEnvelope, authoritative: boolean): void => {
    const eventId = record.eventId?.trim() || null;
    const fallbackKey = executionEnvelopeFallbackKey(record.envelope);
    const existingIndex = eventId
      ? (indexByEventId.get(eventId) ?? fallbackKeys.get(fallbackKey))
      : fallbackKeys.get(fallbackKey);
    if (existingIndex !== undefined) {
      // The outbox projection is authoritative: it carries persisted message_id/seq.
      if (authoritative) merged[existingIndex] = record;
      if (eventId) indexByEventId.set(eventId, existingIndex);
      return;
    }
    const index = merged.length;
    merged.push(record);
    if (eventId) indexByEventId.set(eventId, index);
    else fallbackKeys.set(fallbackKey, index);
  };
  archived.forEach((record) => append(record, false));
  durable.forEach((record) => append(record, true));
  return merged.map(({ envelope }) => envelope);
}

function executionEnvelopeFallbackKey(event: Envelope): string {
  const { message_id: _messageId, seq: _seq, ...rest } = event as Envelope & { message_id?: unknown; seq?: unknown };
  return JSON.stringify([rest.type, rest.run_id ?? null, rest.call_id ?? null, rest.agent_id ?? null, rest.payload ?? null]);
}
