import type { RunStepInfo } from "../../contracts/common.js";
import { normalizeSessionMetadata, type CreateSessionRecordInput, type MessageInfo, type SessionInfo, type SessionListQuery, type SessionMessageListSnapshot } from "../../contracts/session/session.js";
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
import type { ExecutionSessionPort } from "../../contracts/session/session-application.js";

export class AgentSessionApplication implements ExecutionSessionPort {
  constructor(
    private readonly repository: AgentSessionRepositoryPort,
    private readonly history: SessionHistoryPort | null = null,
    private readonly resourceCleanup: SessionResourceCleanup | null = null,
    private readonly workspaceRootResolver: ((session: SessionInfo) => Promise<string | null>) | null = null,
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
    await this.repository.createSession({ tenantId: input.tenantId, sessionId: input.sessionId, ownerUserId: "usr_system", visibility: "tenant", originType: "direct", originId: null, originChannel: "api", workspaceId: null, metadata, permissionMode: input.permissionMode ?? null });
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
    const data = await this.repository.listMessages(input.sessionId, input.limit ?? 20, input.offset ?? 0, threadKey);
    data.items = data.items
      .filter((item) => threadKey === "root" ? isVisibleRootMessage(item) : isVisibleParticipantMessage(item, threadKey))
      .map((item) =>
        item.role === "assistant"
          ? {
              ...item,
              has_execution: Boolean(item.metadata.run_id) && item.metadata.execution_history_discarded !== true,
            }
          : item,
      );
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
    const data = await this.repository.listMessages(input.sessionId, 1000, 0, threadKey);
    const message = data.items.find((item) => item.id === input.messageId
      && (threadKey === "root" ? isVisibleRootMessage(item) : isVisibleParticipantMessage(item, threadKey)));
    if (!message) {
      throw new Error(`消息不存在: ${input.messageId}`);
    }
    if (message.role !== "assistant") {
      throw new Error("仅 assistant 消息支持查询 execution steps");
    }

    const limit = input.limit ?? 500;
    const offset = input.offset ?? 0;
    const rootRunId = message.metadata.run_id ? String(message.metadata.run_id) : null;
    const envelopes = await this.collectRunTreeExecutionEnvelopes(
      input.sessionId,
      rootRunId,
      limit + offset,
      input.messageId,
    );

    return {
      message_id: input.messageId,
      items: envelopes.slice(offset, offset + limit),
      total: envelopes.length,
      limit,
      offset,
      has_more: offset + limit < envelopes.length,
    };
  }

  /**
   * 聚合 root/child run 的持久化 Envelope。系统只支持 protocol.envelope.v1，
   * 数据库 v5 迁移会一次性删除旧 execution.step。
   */
  private async collectRunTreeExecutionEnvelopes(
    sessionId: string,
    rootRunId: string | null,
    perRunLimit: number,
    fallbackMessageId?: string | null,
  ): Promise<Envelope[]> {
    if (!rootRunId) {
      const steps = await this.repository.listRunSteps({
        messageId: fallbackMessageId ?? null,
        sessionId,
        limit: perRunLimit,
      });
      const archived = steps
        .filter((step) => step.step_type === EXECUTION_ENVELOPE_STEP_TYPE)
        .map((step) => parseArchivedEnvelope(step.payload));
      return archived;
    }

    const allRuns = (await this.repository.listRuns(sessionId, 1000)).items;
    const runIds = this.collectRunTreeRunIds(allRuns, rootRunId);
    const steps: RunStepInfo[] = [];
    for (const runId of runIds) {
      steps.push(...await this.repository.listRunSteps({ runId, sessionId, limit: perRunLimit }));
    }
    const archived = steps
      .filter((step) => step.step_type === EXECUTION_ENVELOPE_STEP_TYPE)
      .map((step) => parseArchivedEnvelope(step.payload));
    return archived;
  }

  /** root + 递归子孙 run_id;rootRunId 始终首位,子孙按 created_at 升序(父先于子,applyStep 依赖此序)。 */
  private collectRunTreeRunIds(allRuns: AgentSessionRunRecord[], rootRunId: string): string[] {
    const idSet = new Set<string>([rootRunId]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const run of allRuns) {
        if (run.parent_run_id && idSet.has(run.parent_run_id) && !idSet.has(run.run_id)) {
          idSet.add(run.run_id);
          changed = true;
        }
      }
    }
    const descendants = allRuns
      .filter((run) => idSet.has(run.run_id) && run.run_id !== rootRunId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((run) => run.run_id);
    return [rootRunId, ...descendants];
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
    return this.repository.deleteMessagesAfter(input.sessionId, payload);
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
        execution_events: await this.collectRunTreeExecutionEnvelopes(
          sessionId,
          String(message.metadata.run_id),
          500,
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
  if (item.metadata.react_intermediate) {
    return false;
  }
  if (item.metadata.visible_to_user === false) {
    return false;
  }
  if (item.metadata.conversation_scope === "child") {
    return false;
  }
  if (item.thread_key && item.thread_key !== "root") {
    return false;
  }
  return true;
}

function isVisibleParticipantMessage(item: MessageInfo, threadKey: string): boolean {
  return item.thread_key === threadKey
    && item.metadata.react_intermediate !== true
    && item.metadata.visible_to_user !== false;
}

function parseArchivedEnvelope(payload: Record<string, unknown>): Envelope {
  return EnvelopeSchema.parse(payload) as Envelope;
}
