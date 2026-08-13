import type { AsyncConversationRepository, AsyncRunStore, ExecutionReplayRepositoryPort } from "@ragsystem/backend-core/contracts/storage/async-persistence-ports.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { PermissionMode } from "@ragsystem/backend-core/contracts/runtime/permissions.js";
import { isParticipantConversationMessageVisible } from "@ragsystem/backend-core/contracts/session/message-visibility.js";
import type { CreateSessionRecordInput, MessageInfo, SessionCreateInput, SessionIdentity, SessionInfo, SessionMessageListSnapshot, SessionTeamSnapshotResolver } from "@ragsystem/backend-core/contracts/session/session.js";
import { normalizeSessionMetadata } from "@ragsystem/backend-core/contracts/session/session.js";
import { assertSafeSessionId } from "@ragsystem/backend-core/contracts/session/session-id.js";
import type { AsyncFileHistoryStore } from "@ragsystem/backend-core/contracts/file-history-store/index.js";
import type { RunInfo } from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { RunStepInfo } from "@ragsystem/backend-core/contracts/common.js";
import { EnvelopeSchema, type Envelope } from "@ragsystem/agent-protocol";
import { EXECUTION_ENVELOPE_STEP_TYPE } from "@ragsystem/backend-core/services/runtime/event-outbox/execution-envelope-archive.js";
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
    return this.repository.deleteSession(sessionId);
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
      ...item,
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
  async getLastRunRound(sessionId: string, runId: string): Promise<number> {
    if (!(await this.getSession(sessionId)) || !this.runs) return 0;
    const steps = await this.runs.listRunSteps({ tenantId: this.tenantId, sessionId, runId, limit: 1000 });
    return steps.reduce((max, step) => {
      if (step.step_type !== EXECUTION_ENVELOPE_STEP_TYPE) return max;
      const payload = step.payload.payload;
      const round = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).round
        : undefined;
      return typeof round === "number" && round > max ? round : max;
    }, 0);
  }
  async listMessageRunSteps(input: {
    sessionId: string;
    messageId: string;
    limit?: number;
    offset?: number;
    threadKey?: string | null;
  }): Promise<{ message_id: string; items: Envelope[]; total: number; limit: number; offset: number; has_more: boolean }> {
    if (!(await this.getSession(input.sessionId))) {
      throw new Error(`会话不存在: ${input.sessionId}`);
    }
    const threadKey = input.threadKey?.trim() || "root";
    const message = await this.repository.getMessageById(input.sessionId, input.messageId);
    if (!message || !(threadKey === "root" ? isVisibleRootMessage(message) : isVisibleParticipantMessage(message, threadKey))) {
      throw new Error(`消息不存在: ${input.messageId}`);
    }
    if (!this.runs) {
      throw new Error("SaaS run repository 未配置");
    }

    const limit = input.limit ?? 500;
    const offset = input.offset ?? 0;
    const runId = executionRunId(message);
    const page = runId
      ? await this.runs.listMessageRunSteps({
          tenantId: this.tenantId,
          sessionId: input.sessionId,
          runId,
          messageId: message.id,
          limit,
          offset,
        })
      : { items: [], total: 0 };
    const envelopes = page.items.map((step) => EnvelopeSchema.parse(step.payload) as Envelope);
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

  private async collectRunExecutionEnvelopes(sessionId: string, rootRunId: string): Promise<Envelope[]> {
    if (!this.runs) throw new Error("SaaS run repository 未配置");
    const steps = await this.listRunStepsAll({ runId: rootRunId, sessionId });
    const archived = steps
      .filter((step) => step.step_type === EXECUTION_ENVELOPE_STEP_TYPE)
      .map((step) => ({
        eventId: step.event_id ?? null,
        envelope: EnvelopeSchema.parse(step.payload) as Envelope,
      }));
    return mergeExecutionEnvelopes(archived, []);
  }

  private async listRunStepsAll(input: {
    runId?: string | null;
    sessionId?: string | null;
  }): Promise<RunStepInfo[]> {
    if (!this.runs) throw new Error("SaaS run repository 未配置");
    const pageSize = 500;
    const steps: RunStepInfo[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.runs.listRunSteps({
        tenantId: this.tenantId,
        ...input,
        limit: pageSize,
        offset,
      });
      steps.push(...page);
      if (page.length < pageSize) return steps;
    }
  }
  async updateUserMessage(input: { sessionId: string; messageId: string; content: string }): Promise<boolean> { if (!(await this.getSession(input.sessionId))) return false; return this.repository.updateMessage({ sessionId: input.sessionId, messageId: input.messageId, content: input.content, roleFilter: "user" }); }
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
    const truncateRunSteps = await this.resolveRollbackRunStepTruncation(
      input.sessionId,
      input.afterSeq,
      input.afterMessageId,
    );
    return this.repository.deleteMessagesAfter(input.sessionId, {
      afterSeq: input.afterSeq ?? null,
      afterMessageId: input.afterMessageId ?? null,
      tenantId: this.tenantId,
      ...(truncateRunSteps ? { truncateRunSteps } : {}),
    });
  }

  private async resolveRollbackRunStepTruncation(
    sessionId: string,
    afterSeq?: number | null,
    afterMessageId?: string | null,
  ): Promise<{ runId: string; fromStepOrder: number } | null> {
    if (!this.runs) return null;
    let boundarySeq = afterSeq ?? null;
    if (boundarySeq == null && afterMessageId?.trim()) {
      boundarySeq = (await this.repository.getMessageById(sessionId, afterMessageId.trim()))?.seq ?? null;
    }
    if (boundarySeq == null) return null;
    const firstDeleted = await this.repository.getFirstMessageAfterSeq(sessionId, boundarySeq);
    if (!firstDeleted || !isRunFollowupMessage(firstDeleted)) return null;
    const runId = executionRunId(firstDeleted);
    if (!runId) return null;
    const boundaryStepOrder = await this.runs.getRunMessageBoundary(
      this.tenantId,
      sessionId,
      runId,
      firstDeleted.id,
    );
    return boundaryStepOrder == null ? null : { runId, fromStepOrder: boundaryStepOrder };
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

function isRunFollowupMessage(message: MessageInfo): boolean {
  return message.role === "user"
    && (message.metadata.source === "running_session"
      || message.metadata.execution_kind === "session_followup");
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
