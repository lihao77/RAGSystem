import type { PaginatedResult } from "../../contracts/common.js";
import { normalizeSessionMetadata, type MessageInfo, type SessionInfo, type SessionListItem } from "../../contracts/session.js";
import type { ISessionStore, IMessageStore, IRunStore } from "../stores/conversation-store/index.js";
import type { FileHistoryService } from "../stores/file-history-service.js";

export class AgentSessionApplication {
  constructor(
    private readonly conversationStore: ISessionStore & IMessageStore & IRunStore,
    private readonly fileHistory: FileHistoryService | null = null,
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
    expandSteps?: boolean;
  }): PaginatedResult<MessageInfo> {
    const data = this.conversationStore.listMessages(input.sessionId, input.limit ?? 20, input.offset ?? 0);
    data.items = data.items
      .filter((item) => isVisibleRootMessage(item))
      .map((item) =>
        item.role === "assistant"
          ? {
              ...item,
              has_execution: Boolean(item.metadata.run_id),
            }
          : item,
      );
    if (input.expandSteps) {
      data.items = data.items.map((item) => {
        if (item.role !== "assistant" || !item.metadata.run_id) {
          return item;
        }
        const executionSteps = this.conversationStore
          .listRunSteps({ runId: String(item.metadata.run_id), sessionId: input.sessionId, limit: 500 })
          .filter((step) => step.step_type === "execution.step")
          .map((step) => compactExecutionStep(step.payload));
        return {
          ...item,
          execution_steps: executionSteps,
        } as MessageInfo;
      });
    }
    return data;
  }

  listMessageRunSteps(input: {
    sessionId: string;
    messageId: string;
    limit?: number;
    offset?: number;
  }): { message_id: string; items: Record<string, unknown>[]; total: number; limit: number; offset: number; has_more: boolean } {
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
    const executionSteps = this.conversationStore
      .listRunSteps({ messageId: input.messageId, sessionId: input.sessionId, limit: limit + offset })
      .filter((step) => step.step_type === "execution.step")
      .map((step) => compactExecutionStep(step.payload));

    return {
      message_id: input.messageId,
      items: executionSteps.slice(offset, offset + limit),
      total: executionSteps.length,
      limit,
      offset,
      has_more: offset + limit < executionSteps.length,
    };
  }

  addMessage(input: {
    sessionId: string;
    role: MessageInfo["role"];
    content: string;
    metadata?: Record<string, unknown>;
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
    messages: MessageInfo[];
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
      expandSteps: true,
    });
    if (messages.has_more) {
      messages = this.listMessages({
        sessionId,
        limit: Math.max(messages.total, 1000),
        offset: 0,
        expandSteps: true,
      });
    }
    return {
      version: 1,
      exported_at: new Date().toISOString(),
      session,
      messages: messages.items,
      message_count: messages.items.length,
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

function compactExecutionStep(payload: Record<string, unknown>): Record<string, unknown> {
  const droppedFields = new Set([
    "event_id",
    "timestamp",
    "source_event_type",
    "node_id",
    "parent_node_id",
    "child_agent_id",
    "mode",
    "raw_result",
    "raw_result_ref",
    "resource_refs",
  ]);
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!droppedFields.has(key)) {
      compact[key] = value;
    }
  }
  if (compact.result_preview !== undefined) {
    delete compact.result;
  }
  return compact;
}
