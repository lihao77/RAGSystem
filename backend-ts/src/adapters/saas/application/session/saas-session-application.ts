import type { PaginatedResult } from "../../../../contracts/common.js";
import type { AsyncConversationRepository, AsyncRunStore, ExecutionReplayRepositoryPort } from "../../../../contracts/storage/async-persistence-ports.js";
import type { TenantId } from "../../../../identity/types.js";
import type { PermissionMode } from "../../../../contracts/runtime/permissions.js";
import type { MessageInfo, SessionInfo, SessionListItem } from "../../../../contracts/session/session.js";
import { normalizeSessionMetadata } from "../../../../contracts/session/session.js";
import { assertSafeSessionId } from "../../../../contracts/session/session-id.js";
import type { AsyncFileHistoryStore } from "../../../../contracts/file-history-store/index.js";
import type { RunInfo } from "../../../../contracts/conversation-store/index.js";
import { EnvelopeSchema, type Envelope } from "@ragsystem/agent-protocol";
import { EXECUTION_ENVELOPE_STEP_TYPE } from "../../../../services/runtime/event-outbox/execution-envelope-archive.js";
import { EnvelopeProjector } from "../../../../services/runtime/event-outbox/projector.js";

export class SaaSSessionApplication {
  constructor(
    private readonly tenantId: TenantId,
    private readonly repository: AsyncConversationRepository,
    private readonly fileHistory: AsyncFileHistoryStore | null = null,
    private readonly runs: AsyncRunStore | null = null,
    private readonly outbox: ExecutionReplayRepositoryPort | null = null,
  ) {}
  async createSession(input: { sessionId: string; userId: string; metadata?: Record<string, unknown>; permissionMode?: PermissionMode | null }) {
    assertSafeSessionId(input.sessionId);
    const metadata = normalizeSessionMetadata(input.metadata ?? {});
    await this.repository.createSession(this.tenantId, input.sessionId, input.userId, metadata, input.permissionMode ?? null);
    return { session_id: input.sessionId, user_id: input.userId, permission_mode: input.permissionMode ?? null, metadata };
  }
  listSessions(input: { limit?: number; offset?: number; userIds?: readonly string[] | null }): Promise<PaginatedResult<SessionListItem>> {
    return this.repository.listSessions(this.tenantId, input.limit ?? 20, input.offset ?? 0, input.userIds ?? null);
  }
  async getSession(sessionId: string): Promise<SessionInfo | null> { const row = await this.repository.getSession(sessionId); return row?.tenant_id === this.tenantId ? row : null; }
  /** Returns the raw row so route ownership validation can reject a cross-tenant session id. */
  getSessionForExecutionValidation(sessionId: string): Promise<SessionInfo | null> { return this.repository.getSession(sessionId); }
  async updateSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean> { return (await this.getSession(sessionId)) ? this.repository.updateSessionPermissionMode(sessionId, mode) : false; }
  async deleteSession(sessionId: string): Promise<boolean> {
    if (!(await this.getSession(sessionId))) return false;
    await this.fileHistory?.cleanup(sessionId);
    return this.repository.deleteSession(sessionId);
  }
  async listMessages(input: { sessionId: string; limit?: number; offset?: number }): Promise<PaginatedResult<MessageInfo> | null> {
    if (!(await this.getSession(input.sessionId))) return null;
    const data = await this.repository.listVisibleRootMessages(input.sessionId, input.limit ?? 20, input.offset ?? 0);
    data.items = data.items.map((item) => item.role === "assistant"
      ? { ...item, has_execution: Boolean(item.metadata.run_id) && item.metadata.execution_history_discarded !== true }
      : item);
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
  async listMessageRunSteps(input: {
    sessionId: string;
    messageId: string;
    limit?: number;
    offset?: number;
  }): Promise<{ message_id: string; items: Envelope[]; total: number; limit: number; offset: number; has_more: boolean }> {
    if (!(await this.getSession(input.sessionId))) {
      throw new Error(`会话不存在: ${input.sessionId}`);
    }
    const message = await this.repository.getMessageById(input.sessionId, input.messageId);
    if (!message || !isVisibleRootMessage(message)) {
      throw new Error(`消息不存在: ${input.messageId}`);
    }
    if (message.role !== "assistant") {
      throw new Error("仅 assistant 消息支持查询 execution steps");
    }
    if (!this.runs) {
      throw new Error("SaaS run repository 未配置");
    }

    const limit = input.limit ?? 500;
    const offset = input.offset ?? 0;
    const rootRunId = message.metadata.run_id ? String(message.metadata.run_id) : null;
    let runIds: string[] = [];
    let steps;
    if (!rootRunId) {
      steps = await this.runs.listRunSteps({
        tenantId: this.tenantId,
        messageId: input.messageId,
        sessionId: input.sessionId,
        limit: limit + offset,
      });
    } else {
      const allRuns = (await this.runs.listRuns(this.tenantId, input.sessionId, 1000)).items;
      runIds = collectRunTreeRunIds(allRuns, rootRunId);
      steps = (await Promise.all(runIds.map((runId) => this.runs!.listRunSteps({
        tenantId: this.tenantId,
        runId,
        sessionId: input.sessionId,
        limit: limit + offset,
      })))).flat();
    }
    const archivedEnvelopes = steps
      .filter((step) => step.step_type === EXECUTION_ENVELOPE_STEP_TYPE)
      .map((step) => ({
        eventId: step.event_id ?? null,
        envelope: EnvelopeSchema.parse(step.payload) as Envelope,
      }));
    const durableEnvelopes = this.outbox && rootRunId
      ? await this.collectRunTreeOutboxEnvelopes(input.sessionId, runIds, limit + offset)
      : [];
    const envelopes = mergeExecutionEnvelopes(archivedEnvelopes, durableEnvelopes);
    return {
      message_id: input.messageId,
      items: envelopes.slice(offset, offset + limit),
      total: envelopes.length,
      limit,
      offset,
      has_more: offset + limit < envelopes.length,
    };
  }

  private async collectRunTreeOutboxEnvelopes(
    sessionId: string,
    runIds: string[],
    limit: number,
  ): Promise<StoredExecutionEnvelope[]> {
    if (!this.outbox) return [];
    const rows = await this.outbox.listOutboxForReplay({
      tenantId: this.tenantId,
      sessionId,
      runIds,
      limit: Math.max(1, Math.min(500, limit)),
    });
    const projector = new EnvelopeProjector();
    return rows
      .map((row) => ({ eventId: row.event_id, envelope: projector.toEnvelope(row) }))
      .filter(({ envelope }) => EXECUTION_ENVELOPE_TYPES.has(envelope.type));
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
    return this.repository.deleteMessagesAfter(input.sessionId, {
      afterSeq: input.afterSeq ?? null,
      afterMessageId: input.afterMessageId ?? null,
    });
  }
}

function isVisibleRootMessage(message: MessageInfo): boolean {
  return !message.metadata.react_intermediate
    && message.metadata.visible_to_user !== false
    && message.metadata.conversation_scope !== "child"
    && (!message.thread_key || message.thread_key === "root");
}

function collectRunTreeRunIds(allRuns: RunInfo[], rootRunId: string): string[] {
  const idSet = new Set<string>([rootRunId]);
  for (let changed = true; changed;) {
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

const EXECUTION_ENVELOPE_TYPES = new Set<Envelope["type"]>([
  "agent_started",
  "agent_ended",
  "stream_output",
  "tool_call",
  "tool_result",
]);

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
