import { randomUUID } from "node:crypto";
import type { PaginatedResult } from "@ragsystem/backend-core/contracts/common.js";
import type { MessageInfo } from "@ragsystem/backend-core/contracts/session/session.js";
import type { ConversationDb } from "./shared/db.js";
import { runInTransaction } from "./shared/transaction.js";
import { asNullableString, asString, stringifyJson } from "./helpers.js";
import { decodeChatFields, encodeChatFields } from "@ragsystem/backend-core/contracts/conversation-store/chat-message-codec.js";
import { rowToMessage } from "./mappers.js";
import type { AddMessageInput } from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import { AddMessageInputSchema } from "@ragsystem/backend-core/contracts/conversation-store/types.js";
import type { MessageRow, SqlInputValue } from "./types.js";
import { SessionListProjector } from "./session-list-projector.js";

/**
 * listMessages / getRecentMessages 的默认查询条数上限（SQL LIMIT 防野）。
 * 非上下文裁剪语义——上层 SDK AgentContextBuilder 取历史全量交由 token 压缩按预算裁，
 * 此处仅兜底"调用方未显式传 limit"的极端情况，避免无界扫描。
 */
export const DEFAULT_MESSAGE_LIST_LIMIT = 10_000;

/** messages 聚合根操作（迁移自 ConversationStore，方法体零改动）。 */
export class MessageOps {
  constructor(
    private readonly db: ConversationDb,
    private readonly projector: SessionListProjector,
  ) {}

  addMessage(input: AddMessageInput): MessageInfo {
    const normalized = AddMessageInputSchema.parse(input);
    return runInTransaction(this.db, () => this.addMessageInTransaction(normalized));
  }

  /** 事务内变体（供 ConversationStoreTransaction facade 调用，故 public）。 */
  addMessageInTransaction(input: AddMessageInput): MessageInfo {
    const messageId = input.messageId ?? randomUUID();
    const metadata = { ...(input.metadata ?? {}) };
    const rawThreadKey = input.threadKey ?? asString(metadata.thread_key) ?? "root";
    const threadKey = rawThreadKey.trim() || "root";
    const childAgentId = input.childAgentId ?? asNullableString(metadata.child_agent_id);
    metadata.thread_key = threadKey;
    if (childAgentId) {
      metadata.child_agent_id = childAgentId;
    }
    const persistedMetadata = encodeChatFields(metadata, {
      tool_calls: input.toolCalls,
      tool_call_id: input.toolCallId,
      name: input.name,
    });

    const session = this.db.prepare("SELECT 1 FROM sessions WHERE session_id=?").get(input.sessionId);
    if (!session) throw new Error(`Cannot add message to missing session: ${input.sessionId}`);
    this.db
      .prepare(`
        INSERT INTO messages (id, session_id, role, content, metadata, thread_key, child_agent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(messageId, input.sessionId, input.role, input.content, stringifyJson(persistedMetadata), threadKey, childAgentId);
    this.db.prepare("UPDATE sessions SET updated_at=CURRENT_TIMESTAMP WHERE session_id=?").run(input.sessionId);

    const row = this.db
      .prepare(`
        SELECT seq, id, role, content, metadata, thread_key, child_agent_id, created_at
        FROM messages
        WHERE id=?
      `)
      .get(messageId) as Omit<MessageRow, "session_id"> | undefined;
    if (!row) {
      throw new Error(`Message insert failed: ${messageId}`);
    }

    const message: MessageInfo = {
      seq: row.seq,
      id: row.id,
      session_id: input.sessionId,
      role: row.role,
      content: row.content,
      metadata: persistedMetadata,
      thread_key: row.thread_key ?? "root",
      child_agent_id: row.child_agent_id,
      created_at: row.created_at,
      ...decodeChatFields(persistedMetadata),
    };
    this.projector.projectInsertedMessage(message);
    return message;
  }

  insertCompressionMessage(input: {
    sessionId: string;
    summaryContent: string;
    replacesUpToSeq?: number | null;
    threadKey?: string | undefined;
    childAgentId?: string | null | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): MessageInfo {
    const metadata: Record<string, unknown> = {
      ...(input.metadata ?? {}),
    };
    if (input.replacesUpToSeq !== undefined && input.replacesUpToSeq !== null) {
      metadata.replaces_up_to_seq = input.replacesUpToSeq;
    }
    const messageInput: {
      sessionId: string;
      role: MessageInfo["role"];
      content: string;
      metadata: Record<string, unknown>;
      threadKey?: string;
      childAgentId?: string | null;
    } = {
      sessionId: input.sessionId,
      role: "assistant",
      content: input.summaryContent,
      metadata,
      childAgentId: input.childAgentId ?? null,
    };
    if (input.threadKey !== undefined) {
      messageInput.threadKey = input.threadKey;
    }
    return this.addMessage(messageInput);
  }

  listMessages(sessionId: string, limit = DEFAULT_MESSAGE_LIST_LIMIT, offset = 0, threadKey?: string | null): PaginatedResult<MessageInfo> {
    const resolvedThreadKey = threadKey?.trim() || null;
    const totalRow = this.db
      .prepare("SELECT COUNT(1) AS cnt FROM messages WHERE session_id=? AND (? IS NULL OR thread_key=?)")
      .get(sessionId, resolvedThreadKey, resolvedThreadKey) as { cnt: number };
    const rows = this.db
      .prepare(`
        SELECT seq, id, session_id, role, content, metadata, thread_key, child_agent_id, created_at
        FROM messages
        WHERE session_id=? AND (? IS NULL OR thread_key=?)
        ORDER BY seq DESC
        LIMIT ? OFFSET ?
      `)
      .all(sessionId, resolvedThreadKey, resolvedThreadKey, limit, offset) as unknown as MessageRow[];

    const items = rows.map(rowToMessage).reverse();
    return {
      items,
      total: totalRow.cnt,
      limit,
      offset,
      has_more: offset + limit < totalRow.cnt,
    };
  }

  getMessageBySeq(sessionId: string, seq: number): MessageInfo | null {
    const row = this.db
      .prepare(`
        SELECT seq, id, session_id, role, content, metadata, thread_key, child_agent_id, created_at
        FROM messages
        WHERE session_id=? AND seq=?
      `)
      .get(sessionId, seq) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  getMessageById(sessionId: string, messageId: string): MessageInfo | null {
    const row = this.db
      .prepare(`
        SELECT seq, id, session_id, role, content, metadata, thread_key, child_agent_id, created_at
        FROM messages
        WHERE session_id=? AND id=?
      `)
      .get(sessionId, messageId) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  getFirstMessageAfterSeq(sessionId: string, seq: number): MessageInfo | null {
    const row = this.db
      .prepare(`
        SELECT seq, id, session_id, role, content, metadata, thread_key, child_agent_id, created_at
        FROM messages
        WHERE session_id=? AND seq>?
        ORDER BY seq ASC
        LIMIT 1
      `)
      .get(sessionId, seq) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  listMessagesAfterSeq(sessionId: string, seq: number, limit = 20): MessageInfo[] {
    const rows = this.db
      .prepare(`
        SELECT seq, id, session_id, role, content, metadata, thread_key, child_agent_id, created_at
        FROM messages
        WHERE session_id=? AND seq>?
        ORDER BY seq ASC
        LIMIT ?
      `)
      .all(sessionId, seq, limit) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  listMessagesBeforeOrAtSeq(sessionId: string, seq: number, limit = 20): MessageInfo[] {
    const rows = this.db
      .prepare(`
        SELECT seq, id, session_id, role, content, metadata, thread_key, child_agent_id, created_at
        FROM messages
        WHERE session_id=? AND seq<=?
        ORDER BY seq DESC
        LIMIT ?
      `)
      .all(sessionId, seq, limit) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  getRecentMessages(sessionId: string, limit = DEFAULT_MESSAGE_LIST_LIMIT, threadKey?: string | null): MessageInfo[] {
    return this.listMessages(sessionId, limit, 0, threadKey).items;
  }

  deleteMessagesAfter(sessionId: string, input: { afterSeq?: number | null; afterMessageId?: string | null }): number {
    let afterSeq = input.afterSeq ?? null;
    if (input.afterMessageId) {
      const row = this.db
        .prepare("SELECT seq FROM messages WHERE session_id=? AND id=?")
        .get(sessionId, input.afterMessageId) as { seq: number } | undefined;
      if (!row) {
        return 0;
      }
      afterSeq = row.seq;
    }
    if (afterSeq === null) {
      return 0;
    }

    return runInTransaction(this.db, () => {
      const rows = this.db
        .prepare("SELECT id FROM messages WHERE session_id=? AND seq > ?")
        .all(sessionId, afterSeq) as Array<{ id: string }>;
      if (rows.length === 0) {
        return 0;
      }
      const messageIds = rows.map((row) => row.id);
      const placeholders = messageIds.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM run_steps WHERE message_id IN (${placeholders})`).run(...messageIds);
      this.db.prepare("DELETE FROM messages WHERE session_id=? AND seq > ?").run(sessionId, afterSeq);
      this.db
        .prepare("DELETE FROM child_agents WHERE session_id=? AND created_seq IS NOT NULL AND created_seq > ?")
        .run(sessionId, afterSeq);
      this.db.prepare("UPDATE sessions SET updated_at=CURRENT_TIMESTAMP WHERE session_id=?").run(sessionId);
      this.projector.rebuildSessionListProjection(sessionId);
      return rows.length;
    });
  }

  updateMessage(input: {
    messageId: string;
    content?: string | null;
    metadata?: Record<string, unknown> | null;
    sessionId?: string | null;
    roleFilter?: MessageInfo["role"] | null;
  }): boolean {
    return runInTransaction(this.db, () => this.updateMessageInTransaction(input));
  }

  updateMessageInTransaction(input: {
    messageId: string;
    content?: string | null;
    metadata?: Record<string, unknown> | null;
    sessionId?: string | null;
    roleFilter?: MessageInfo["role"] | null;
  }): boolean {
    const updates: string[] = [];
    const params: SqlInputValue[] = [];
    if (input.content !== undefined && input.content !== null) {
      updates.push("content=?");
      params.push(input.content);
    }
    if (input.metadata !== undefined && input.metadata !== null) {
      updates.push("metadata=?");
      params.push(stringifyJson(input.metadata));
    }
    if (updates.length === 0) {
      return false;
    }

    const where = ["id=?"];
    const whereParams: SqlInputValue[] = [input.messageId];
    if (input.sessionId !== undefined && input.sessionId !== null) {
      where.push("session_id=?");
      whereParams.push(input.sessionId);
    }
    if (input.roleFilter !== undefined && input.roleFilter !== null) {
      where.push("role=?");
      whereParams.push(input.roleFilter);
    }

    const whereClause = where.join(" AND ");
    const row = this.db.prepare(`SELECT seq, session_id FROM messages WHERE ${whereClause}`).get(...whereParams) as { seq: number; session_id: string } | undefined;
    if (!row) {
      return false;
    }
    const result = this.db.prepare(`UPDATE messages SET ${updates.join(", ")} WHERE ${whereClause}`).run(...params, ...whereParams);
    if (Number(result.changes) > 0) this.projector.rebuildSessionListProjection(row.session_id);
    return Number(result.changes) > 0;
  }
}
