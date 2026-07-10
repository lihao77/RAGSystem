import type { PaginatedResult } from "../../contracts/common.js";
import { normalizeSessionMetadata, type MessageInfo, type SessionInfo, type SessionListItem } from "../../contracts/session.js";
import type { IMessageStore, IRunStore, ISessionStore, RunInfo } from "../../contracts/conversation-store/index.js";
import type { IFileHistoryStore } from "../../contracts/file-history-store/index.js";
import type { MessageExtension } from "../agent/context/extensions/kinds.js";
import { EnvelopeSchema, type Envelope } from "@ragsystem/agent-protocol";
import { EXECUTION_ENVELOPE_STEP_TYPE } from "../runtime/event-outbox/execution-envelope-archive.js";

export class AgentSessionApplication {
  constructor(
    private readonly conversationStore: ISessionStore & IMessageStore & IRunStore,
    private readonly fileHistory: IFileHistoryStore | null = null,
  ) {}

  createSession(input: {
    sessionId: string;
    userId?: string | null;
    metadata?: Record<string, unknown>;
  }): { session_id: string; user_id: string | null; metadata: Record<string, unknown> } {
    const metadata = normalizeSessionMetadata(input.metadata ?? {});
    this.conversationStore.createSession(input.sessionId, input.userId ?? null, metadata);
    return {
      session_id: input.sessionId,
      user_id: input.userId ?? null,
      metadata,
    };
  }

  listSessions(input: { limit?: number; offset?: number; userId?: string | null }): PaginatedResult<SessionListItem> {
    return this.conversationStore.listSessions(input.limit ?? 20, input.offset ?? 0, input.userId ?? null);
  }

  getSession(sessionId: string): SessionInfo | null {
    return this.conversationStore.getSession(sessionId);
  }

  deleteSession(sessionId: string): boolean {
    this.fileHistory?.cleanup(sessionId);
    return this.conversationStore.deleteSession(sessionId);
  }

  listMessages(input: {
    sessionId: string;
    limit?: number;
    offset?: number;
  }): PaginatedResult<MessageInfo> {
    const data = this.conversationStore.listMessages(input.sessionId, input.limit ?? 20, input.offset ?? 0);
    data.items = data.items
      .filter((item) => isVisibleRootMessage(item))
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

  listMessageRunSteps(input: {
    sessionId: string;
    messageId: string;
    limit?: number;
    offset?: number;
  }): { message_id: string; items: Envelope[]; total: number; limit: number; offset: number; has_more: boolean } {
    const data = this.conversationStore.listMessages(input.sessionId, 1000, 0);
    const message = data.items.find((item) => item.id === input.messageId && isVisibleRootMessage(item));
    if (!message) {
      throw new Error(`消息不存在: ${input.messageId}`);
    }
    if (message.role !== "assistant") {
      throw new Error("仅 assistant 消息支持查询 execution steps");
    }

    const limit = input.limit ?? 500;
    const offset = input.offset ?? 0;
    const rootRunId = message.metadata.run_id ? String(message.metadata.run_id) : null;
    const envelopes = this.collectRunTreeExecutionEnvelopes(
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
  private collectRunTreeExecutionEnvelopes(
    sessionId: string,
    rootRunId: string | null,
    perRunLimit: number,
    fallbackMessageId?: string | null,
  ): Envelope[] {
    if (!rootRunId) {
      const steps = this.conversationStore.listRunSteps({
        messageId: fallbackMessageId ?? null,
        sessionId,
        limit: perRunLimit,
      });
      const archived = steps
        .filter((step) => step.step_type === EXECUTION_ENVELOPE_STEP_TYPE)
        .map((step) => parseArchivedEnvelope(step.payload));
      return archived;
    }

    const allRuns = this.conversationStore.listRuns(sessionId, 1000).items;
    const runIds = this.collectRunTreeRunIds(allRuns, rootRunId);
    const steps = runIds.flatMap((runId) =>
      this.conversationStore.listRunSteps({ runId, sessionId, limit: perRunLimit }),
    );
    const archived = steps
      .filter((step) => step.step_type === EXECUTION_ENVELOPE_STEP_TYPE)
      .map((step) => parseArchivedEnvelope(step.payload));
    return archived;
  }

  /** root + 递归子孙 run_id;rootRunId 始终首位,子孙按 created_at 升序(父先于子,applyStep 依赖此序)。 */
  private collectRunTreeRunIds(allRuns: RunInfo[], rootRunId: string): string[] {
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

  addMessage(input: {
    sessionId: string;
    role: MessageInfo["role"];
    content: string;
    metadata?: Record<string, unknown>;
    toolCalls?: MessageInfo["tool_calls"];
    toolCallId?: string | undefined;
    name?: string | undefined;
    messageId?: string;
    threadKey?: string;
    childAgentId?: string | null;
  }): MessageInfo {
    const message = this.conversationStore.addMessage(input);
    if (message.role === "user" && isVisibleRootMessage(message)) {
      const snapshotId = this.fileHistory?.makeSnapshot(input.sessionId, message.seq);
      if (snapshotId) {
        const metadata = {
          ...message.metadata,
          snapshot_id: snapshotId,
        };
        this.conversationStore.updateMessage({
          messageId: message.id,
          metadata,
          sessionId: input.sessionId,
          roleFilter: "user",
        });
        return {
          ...message,
          metadata,
        };
      }
    }
    return message;
  }

  updateUserMessage(input: { sessionId: string; messageId: string; content: string }): boolean {
    return this.conversationStore.updateMessage({
      messageId: input.messageId,
      content: input.content,
      sessionId: input.sessionId,
      roleFilter: "user",
    });
  }

  prepareRetry(input: {
    sessionId: string;
    afterSeq?: number | null;
    afterMessageId?: string | null;
    modifyUserMessage?: string | null;
    metadataPatch?: { attachments?: unknown[]; extensions?: MessageExtension[] };
  }): { deleted: number; task: string; message: MessageInfo } {
    const originalMessage = this.resolveRetryAnchor(input.sessionId, input.afterSeq, input.afterMessageId);
    if (!originalMessage) {
      const description =
        input.afterSeq !== undefined && input.afterSeq !== null
          ? `序号为 ${input.afterSeq}`
          : `ID 为 ${input.afterMessageId ?? ""}`;
      throw new Error(`未找到会话 ${input.sessionId} 中${description}的消息`);
    }
    if (originalMessage.role !== "user") {
      throw new Error("指定位置必须是用户消息（user），才能从此处重试");
    }

    const modifiedTask = input.modifyUserMessage?.trim();
    const task = modifiedTask || originalMessage.content.trim();
    if (!task) {
      throw new Error("无法获取要重试的任务内容");
    }

    const message = modifiedTask
      ? {
          ...originalMessage,
          content: task,
          metadata: {
            ...originalMessage.metadata,
            ...(input.metadataPatch ?? {}),
            retry_modified_at: new Date().toISOString(),
          },
        }
      : originalMessage;
    if (modifiedTask) {
      const snapshotId = this.fileHistory?.makeSnapshot(input.sessionId, originalMessage.seq);
      if (snapshotId) {
        message.metadata.snapshot_id = snapshotId;
      }
      const updated = this.conversationStore.updateMessage({
        messageId: originalMessage.id,
        content: task,
        metadata: message.metadata,
        sessionId: input.sessionId,
        roleFilter: "user",
      });
      if (!updated) {
        throw new Error("消息不存在或不可编辑");
      }
    }

    const deleted = this.rollbackMessages({
      sessionId: input.sessionId,
      afterSeq: message.seq,
    });
    return { deleted, task, message };
  }

  rollbackMessages(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): number {
    const payload: { afterSeq?: number | null; afterMessageId?: string | null } = {};
    if (input.afterSeq !== undefined) {
      payload.afterSeq = input.afterSeq;
    }
    if (input.afterMessageId !== undefined) {
      payload.afterMessageId = input.afterMessageId;
    }
    this.rollbackFileSnapshot(input.sessionId, input.afterSeq, input.afterMessageId);
    return this.conversationStore.deleteMessagesAfter(input.sessionId, payload);
  }

  exportSession(sessionId: string): {
    version: number;
    exported_at: string;
    session: SessionInfo;
    messages: Array<MessageInfo & { execution_events?: Envelope[] }>;
    message_count: number;
  } {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    let messages = this.listMessages({
      sessionId,
      limit: 1000,
      offset: 0,
    });
    if (messages.has_more) {
      messages = this.listMessages({
        sessionId,
        limit: Math.max(messages.total, 1000),
        offset: 0,
      });
    }
    const exportedMessages = messages.items.map((message) => {
      if (message.role !== "assistant" || !message.metadata.run_id) {
        return message;
      }
      return {
        ...message,
        execution_events: this.collectRunTreeExecutionEnvelopes(
          sessionId,
          String(message.metadata.run_id),
          500,
        ),
      };
    });
    return {
      version: 2,
      exported_at: new Date().toISOString(),
      session,
      messages: exportedMessages,
      message_count: exportedMessages.length,
    };
  }

  private resolveRetryAnchor(sessionId: string, afterSeq?: number | null, afterMessageId?: string | null): MessageInfo | null {
    if (afterSeq !== undefined && afterSeq !== null) {
      return this.conversationStore.getMessageBySeq(sessionId, afterSeq);
    }
    const messageId = afterMessageId?.trim();
    if (!messageId) {
      return null;
    }
    return this.conversationStore.getMessageById(sessionId, messageId);
  }

  private rollbackFileSnapshot(sessionId: string, afterSeq?: number | null, afterMessageId?: string | null): void {
    if (!this.fileHistory?.hasSnapshots(sessionId)) {
      return;
    }
    const anchor = this.resolveSnapshotAnchorUserMessage(sessionId, afterSeq, afterMessageId);
    if (!anchor) {
      return;
    }
    this.fileHistory.rewind(sessionId, anchor.seq);
  }

  private resolveSnapshotAnchorUserMessage(
    sessionId: string,
    afterSeq?: number | null,
    afterMessageId?: string | null,
  ): MessageInfo | null {
    let targetMessage: MessageInfo | null = null;
    if (afterSeq !== undefined && afterSeq !== null) {
      targetMessage = this.conversationStore.getMessageBySeq(sessionId, afterSeq);
    } else {
      const messageId = afterMessageId?.trim();
      if (messageId) {
        targetMessage = this.conversationStore.getMessageById(sessionId, messageId);
      }
    }

    if (!targetMessage && afterSeq !== undefined && afterSeq !== null) {
      targetMessage = this.conversationStore.getFirstMessageAfterSeq(sessionId, afterSeq);
    }
    if (!targetMessage) {
      return null;
    }
    if (targetMessage.role === "user" && isVisibleRootMessage(targetMessage)) {
      return targetMessage;
    }

    const nextUser = this.conversationStore
      .listMessagesAfterSeq(sessionId, targetMessage.seq, 20)
      .find((message) => message.role === "user" && isVisibleRootMessage(message));
    if (nextUser) {
      return nextUser;
    }
    return this.conversationStore
      .listMessagesBeforeOrAtSeq(sessionId, targetMessage.seq, 20)
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

function parseArchivedEnvelope(payload: Record<string, unknown>): Envelope {
  return EnvelopeSchema.parse(payload) as Envelope;
}
