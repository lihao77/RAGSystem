import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import type { PaginatedResult, RunStepInfo } from "../../contracts/common.js";
import type { MessageInfo, SessionInfo, SessionListItem } from "../../contracts/session.js";
import { asNullableString, asString, parseJsonObject, stringifyJson } from "./conversation-store/helpers.js";
import { rowToChildAgent, rowToMessage, rowToResource, rowToRun, rowToRunStep, rowToSession, rowToSessionListItem } from "./conversation-store/mappers.js";
import { inferResourceScope } from "./conversation-store/resource-scope.js";
import { initializeConversationSchema } from "./conversation-store/schema.js";
import type {
  ChildAgentInfo,
  ChildAgentRow,
  MessageRow,
  OutboxRow,
  ResourceInfo,
  ResourceRow,
  RunInfo,
  RunRow,
  RunStepRow,
  SessionListRow,
  SessionRow,
  SqlInputValue,
} from "./conversation-store/types.js";

export type { ChildAgentInfo, ResourceInfo, RunInfo } from "./conversation-store/types.js";

const CHILD_AGENT_SELECT_COLUMNS = `
  child_agent_id, session_id, agent_name, thread_key, status,
  created_seq, created_by_run_id, created_by_call_id, parent_run_id, parent_call_id,
  last_run_id, metadata, created_at, updated_at
`;

const RUN_STEP_SELECT_COLUMNS = "id, run_id, session_id, message_id, step_order, step_type, payload, created_at";
const OUTBOX_SELECT_COLUMNS = `
  id, event_id, session_id, run_id, session_seq, event_type, aggregate_type,
  aggregate_id, payload, status, attempts, available_at, locked_at, delivered_at,
  last_error, created_at
`;

export interface ConversationStoreOptions {
  dbPath: string;
  dataRoot?: string | undefined;
}

export interface AddMessageInput {
  sessionId: string;
  role: MessageInfo["role"];
  content: string;
  metadata?: Record<string, unknown>;
  messageId?: string;
  threadKey?: string;
  childAgentId?: string | null;
}

export interface AddRunStepInput {
  sessionId: string;
  runId: string;
  stepType: string;
  payload: Record<string, unknown>;
  messageId?: string | null;
}

export interface RunStepRecord {
  id: number;
  run_id: string;
  step_order: number;
  step_type: string;
}

export interface AppendOutboxInput {
  sessionId: string;
  runId?: string | null;
  eventId?: string;
  sessionSeq?: number;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  availableAt?: string | null;
}

export interface ClaimOutboxInput {
  limit?: number;
  lockTimeoutMs?: number;
  now?: Date;
}

export type OutboxStatus = "pending" | "retrying" | "delivered" | "failed";

export interface ListOutboxInput {
  statuses?: OutboxStatus[] | undefined;
  sessionId?: string | null | undefined;
  runId?: string | null | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface RetryOutboxBatchInput {
  ids?: number[] | undefined;
  statuses?: OutboxStatus[] | undefined;
  limit?: number | undefined;
  availableAt?: string | undefined;
}

export interface RetryOutboxResult {
  matched: number;
  retried: number;
  ids: number[];
}

export interface DeleteDeliveredOutboxInput {
  before: string;
  limit?: number | undefined;
}

export interface ConversationStoreTransaction {
  addMessage(input: AddMessageInput): MessageInfo;
  addRunStep(input: AddRunStepInput): RunStepRecord;
  updateRunStepsMessageId(sessionId: string, runId: string, messageId: string): number;
  updateRunStatus(runId: string, sessionId: string, status: string, finalMessageId?: string | null): boolean;
  nextSessionSeq(sessionId: string): number;
  appendOutbox(input: AppendOutboxInput): OutboxRow;
}

export interface EventOutboxStats {
  total: number;
  pending: number;
  retrying: number;
  delivered: number;
  failed: number;
  locked: number;
  ready: number;
  oldest_pending_created_at: string | null;
  oldest_pending_age_seconds: number | null;
  oldest_retrying_created_at: string | null;
  oldest_retrying_age_seconds: number | null;
  oldest_pending_or_retrying_created_at: string | null;
  oldest_pending_or_retrying_age_seconds: number | null;
  oldest_failed_created_at: string | null;
  oldest_failed_age_seconds: number | null;
  recent_failed_errors: EventOutboxErrorSummary[];
}

export interface EventOutboxErrorSummary {
  id: number;
  event_id: string;
  session_id: string;
  run_id: string | null;
  event_type: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export class ConversationStore {
  private readonly db: import("node:sqlite").DatabaseSync;
  private readonly dataRoot: string;

  constructor(options: ConversationStoreOptions) {
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
    if (options.dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    initializeConversationSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  createSession(sessionId: string, userId: string | null = null, metadata: Record<string, unknown> = {}): void {
    this.db
      .prepare(`
        INSERT INTO sessions (session_id, user_id, metadata)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          user_id=excluded.user_id,
          metadata=excluded.metadata,
          updated_at=CURRENT_TIMESTAMP
      `)
      .run(sessionId, userId, stringifyJson(metadata));
  }

  getSession(sessionId: string): SessionInfo | null {
    const row = this.db
      .prepare("SELECT session_id, user_id, metadata, created_at, updated_at FROM sessions WHERE session_id=?")
      .get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  deleteSession(sessionId: string): boolean {
    const result = this.withTransaction(() => {
      this.db.prepare("DELETE FROM step_resources WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM resources WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM run_steps WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM runs WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM child_agents WHERE session_id=?").run(sessionId);
      return this.db.prepare("DELETE FROM sessions WHERE session_id=?").run(sessionId);
    });
    return Number(result.changes) > 0;
  }

  addMessage(input: AddMessageInput): MessageInfo {
    return this.withTransaction(() => this.addMessageInTransaction(input));
  }

  private addMessageInTransaction(input: AddMessageInput): MessageInfo {
    const messageId = input.messageId ?? randomUUID();
    const metadata = { ...(input.metadata ?? {}) };
    const rawThreadKey = input.threadKey ?? asString(metadata.thread_key) ?? "root";
    const threadKey = rawThreadKey.trim() || "root";
    const childAgentId = input.childAgentId ?? asNullableString(metadata.child_agent_id);
    metadata.thread_key = threadKey;
    if (childAgentId) {
      metadata.child_agent_id = childAgentId;
    }

    this.db.prepare("INSERT OR IGNORE INTO sessions (session_id, metadata) VALUES (?, ?)").run(input.sessionId, "{}");
    this.db
      .prepare(`
        INSERT INTO messages (id, session_id, role, content, metadata, thread_key, child_agent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(messageId, input.sessionId, input.role, input.content, stringifyJson(metadata), threadKey, childAgentId);
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

    return {
      seq: row.seq,
      id: row.id,
      session_id: input.sessionId,
      role: row.role,
      content: row.content,
      metadata,
      thread_key: row.thread_key ?? "root",
      child_agent_id: row.child_agent_id,
      created_at: row.created_at,
    };
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
      compression: true,
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

  listMessages(sessionId: string, limit = 20, offset = 0, threadKey?: string | null): PaginatedResult<MessageInfo> {
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

  getRecentMessages(sessionId: string, limit = 20, threadKey?: string | null): MessageInfo[] {
    return this.listMessages(sessionId, limit, 0, threadKey).items;
  }

  listSessions(limit = 20, offset = 0, userId?: string | null): PaginatedResult<SessionListItem> {
    const resolvedUserId = userId?.trim() ? userId.trim() : null;
    const totalRow = this.db
      .prepare("SELECT COUNT(1) AS cnt FROM sessions WHERE (? IS NULL OR user_id = ?)")
      .get(resolvedUserId, resolvedUserId) as { cnt: number };
    const rows = this.db
      .prepare(`
        SELECT
          s.session_id,
          s.user_id,
          s.metadata,
          s.created_at,
          s.updated_at,
          (
            SELECT content
            FROM messages m
            WHERE m.session_id = s.session_id
            ORDER BY seq DESC
            LIMIT 1
          ) AS last_content,
          (
            SELECT created_at
            FROM messages m
            WHERE m.session_id = s.session_id
            ORDER BY seq DESC
            LIMIT 1
          ) AS last_created_at,
          (
            SELECT content
            FROM messages m
            WHERE m.session_id = s.session_id
            ORDER BY seq ASC
            LIMIT 1
          ) AS first_content
        FROM sessions s
        WHERE (? IS NULL OR s.user_id = ?)
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(resolvedUserId, resolvedUserId, limit, offset) as unknown as SessionListRow[];

    return {
      items: rows.map(rowToSessionListItem),
      total: totalRow.cnt,
      limit,
      offset,
      has_more: offset + limit < totalRow.cnt,
    };
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

    const rows = this.db
      .prepare("SELECT id FROM messages WHERE session_id=? AND seq > ?")
      .all(sessionId, afterSeq) as Array<{ id: string }>;
    if (rows.length === 0) {
      return 0;
    }

    const messageIds = rows.map((row) => row.id);

    this.withTransaction(() => {
      if (messageIds.length > 0) {
        const placeholders = messageIds.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM run_steps WHERE message_id IN (${placeholders})`).run(...messageIds);
      }
      this.db.prepare("DELETE FROM messages WHERE session_id=? AND seq > ?").run(sessionId, afterSeq);
      this.db
        .prepare("DELETE FROM child_agents WHERE session_id=? AND created_seq IS NOT NULL AND created_seq > ?")
        .run(sessionId, afterSeq);
      this.db.prepare("UPDATE sessions SET updated_at=CURRENT_TIMESTAMP WHERE session_id=?").run(sessionId);
    });
    return rows.length;
  }

  updateMessage(input: {
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
    const row = this.db.prepare(`SELECT seq FROM messages WHERE ${whereClause}`).get(...whereParams);
    if (!row) {
      return false;
    }
    const result = this.db.prepare(`UPDATE messages SET ${updates.join(", ")} WHERE ${whereClause}`).run(...params, ...whereParams);
    return Number(result.changes) > 0;
  }

  addRunStep(input: AddRunStepInput): RunStepRecord {
    return this.withTransaction(() => this.addRunStepInTransaction(input));
  }

  private addRunStepInTransaction(input: AddRunStepInput): RunStepRecord {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(step_order), 0) + 1 AS next_order FROM run_steps WHERE session_id=? AND run_id=?")
      .get(input.sessionId, input.runId) as { next_order: number };
    const stepOrder = Number(row.next_order) || 1;
    const result = this.db
      .prepare(`
        INSERT INTO run_steps (run_id, session_id, message_id, step_order, step_type, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(input.runId, input.sessionId, input.messageId ?? null, stepOrder, input.stepType, stringifyJson(input.payload));
    return {
      id: Number(result.lastInsertRowid),
      run_id: input.runId,
      step_order: stepOrder,
      step_type: input.stepType,
    };
  }

  updateRunStepsMessageId(sessionId: string, runId: string, messageId: string): number {
    const result = this.db
      .prepare("UPDATE run_steps SET message_id=? WHERE session_id=? AND run_id=?")
      .run(messageId, sessionId, runId);
    return Number(result.changes);
  }

  createChildAgent(input: {
    childAgentId: string;
    sessionId: string;
    agentName: string;
    threadKey?: string | null;
    createdSeq?: number | null;
    createdByRunId?: string | null;
    createdByCallId?: string | null;
    parentRunId?: string | null;
    parentCallId?: string | null;
    lastRunId?: string | null;
    metadata?: Record<string, unknown>;
    status?: string;
  }): ChildAgentInfo {
    const threadKey = input.threadKey?.trim() || `child:${input.childAgentId}`;
    const status = input.status ?? "active";
    const metadata = input.metadata ?? {};
    this.db
      .prepare(
        `
          INSERT INTO child_agents (
            child_agent_id, session_id, agent_name, thread_key, status,
            created_seq, created_by_run_id, created_by_call_id, parent_run_id, parent_call_id,
            last_run_id, metadata
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.childAgentId,
        input.sessionId,
        input.agentName,
        threadKey,
        status,
        input.createdSeq ?? null,
        input.createdByRunId ?? null,
        input.createdByCallId ?? null,
        input.parentRunId ?? null,
        input.parentCallId ?? null,
        input.lastRunId ?? null,
        stringifyJson(metadata),
      );
    const row = this.db
      .prepare(
        `
          SELECT ${CHILD_AGENT_SELECT_COLUMNS}
          FROM child_agents
          WHERE session_id=? AND child_agent_id=?
        `,
      )
      .get(input.sessionId, input.childAgentId) as ChildAgentRow | undefined;
    if (!row) {
      throw new Error(`Child agent insert failed: ${input.childAgentId}`);
    }
    return rowToChildAgent(row);
  }

  listChildAgents(input: {
    sessionId: string;
    agentName?: string | null;
    limit?: number;
  }): { items: ChildAgentInfo[]; total: number } {
    const agentName = input.agentName ?? null;
    const limit = input.limit ?? 100;
    const rows = this.db
      .prepare(
        `
          SELECT ${CHILD_AGENT_SELECT_COLUMNS}
          FROM child_agents
          WHERE session_id=? AND (? IS NULL OR agent_name=?)
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(input.sessionId, agentName, agentName, limit) as unknown as ChildAgentRow[];
    const items = rows.map(rowToChildAgent);
    return { items, total: items.length };
  }

  getChildAgent(sessionId: string, childAgentId: string): ChildAgentInfo | null {
    const row = this.db
      .prepare(
        `
          SELECT ${CHILD_AGENT_SELECT_COLUMNS}
          FROM child_agents
          WHERE session_id=? AND child_agent_id=?
        `,
      )
      .get(sessionId, childAgentId) as ChildAgentRow | undefined;
    return row ? rowToChildAgent(row) : null;
  }

  updateChildAgentLastRun(input: {
    sessionId: string;
    childAgentId: string;
    lastRunId: string;
  }): boolean {
    const result = this.db
      .prepare(
        `
          UPDATE child_agents
          SET last_run_id=?, updated_at=CURRENT_TIMESTAMP
          WHERE session_id=? AND child_agent_id=?
        `,
      )
      .run(input.lastRunId, input.sessionId, input.childAgentId);
    return Number(result.changes) > 0;
  }

  getRecentMessagesByChildAgent(sessionId: string, childAgentId: string, limit = 20): MessageInfo[] {
    const child = this.getChildAgent(sessionId, childAgentId);
    if (!child) {
      return [];
    }
    return this.getRecentMessages(sessionId, limit, child.thread_key);
  }

  createRun(input: {
    runId: string;
    sessionId: string;
    entrypoint?: string;
    status?: string;
    taskSummary?: string;
    userId?: string | null;
    agentName?: string | null;
    threadKey?: string | null;
    parentRunId?: string | null;
    parentCallId?: string | null;
    childAgentId?: string | null;
  }): {
    run_id: string;
    session_id: string;
    status: string;
    thread_key: string;
    parent_run_id: string | null;
    parent_call_id: string | null;
    child_agent_id: string | null;
  } {
    const threadKey = input.threadKey?.trim() || "root";
    const status = input.status ?? "running";
    this.db
      .prepare(
        `
          INSERT INTO runs (
            run_id, session_id, entrypoint, status, task_summary,
            user_id, agent_name, thread_key, parent_run_id, parent_call_id, child_agent_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.runId,
        input.sessionId,
        input.entrypoint ?? "execute",
        status,
        input.taskSummary ?? "",
        input.userId ?? null,
        input.agentName ?? null,
        threadKey,
        input.parentRunId ?? null,
        input.parentCallId ?? null,
        input.childAgentId ?? null,
      );
    return {
      run_id: input.runId,
      session_id: input.sessionId,
      status,
      thread_key: threadKey,
      parent_run_id: input.parentRunId ?? null,
      parent_call_id: input.parentCallId ?? null,
      child_agent_id: input.childAgentId ?? null,
    };
  }

  updateRunStatus(runId: string, sessionId: string, status: string, finalMessageId: string | null = null): boolean {
    const result = this.db
      .prepare(
        `
          UPDATE runs
          SET status=?, final_message_id=?, updated_at=CURRENT_TIMESTAMP
          WHERE run_id=? AND session_id=?
        `,
      )
      .run(status, finalMessageId, runId, sessionId);
    return Number(result.changes) > 0;
  }

  runInTransaction<T>(operation: (tx: ConversationStoreTransaction) => T): T {
    return this.withTransaction(() => operation(this.createTransactionFacade()));
  }

  getNextSessionSeq(sessionId: string): number {
    return this.withTransaction(() => this.nextSessionSeqInTransaction(sessionId));
  }

  appendOutbox(input: AppendOutboxInput): OutboxRow {
    return this.withTransaction(() => this.appendOutboxInTransaction(input));
  }

  fetchPendingOutbox(limit = 100): OutboxRow[] {
    return this.db
      .prepare(`
        SELECT ${OUTBOX_SELECT_COLUMNS}
        FROM event_outbox
        WHERE status IN ('pending', 'retrying') AND available_at <= ?
        ORDER BY id ASC
        LIMIT ?
      `)
      .all(nowIso(), limit) as unknown as OutboxRow[];
  }

  claimPendingOutbox(input: ClaimOutboxInput = {}): OutboxRow[] {
    const limit = Math.max(1, Math.floor(input.limit ?? 100));
    const now = input.now ?? new Date();
    const lockedAt = now.toISOString();
    const staleBefore = new Date(now.getTime() - Math.max(0, input.lockTimeoutMs ?? 60_000)).toISOString();
    return this.withTransaction(() => {
      const ids = this.db
        .prepare(`
          SELECT id
          FROM event_outbox
          WHERE status IN ('pending', 'retrying')
            AND available_at <= ?
            AND (locked_at IS NULL OR locked_at <= ?)
          ORDER BY id ASC
          LIMIT ?
        `)
        .all(lockedAt, staleBefore, limit) as Array<{ id: number }>;
      if (ids.length === 0) {
        return [];
      }
      const placeholders = ids.map(() => "?").join(", ");
      const idValues = ids.map((row) => row.id);
      this.db
        .prepare(`
          UPDATE event_outbox
          SET locked_at=?
          WHERE id IN (${placeholders})
            AND status IN ('pending', 'retrying')
            AND available_at <= ?
            AND (locked_at IS NULL OR locked_at <= ?)
        `)
        .run(lockedAt, ...idValues, lockedAt, staleBefore);
      return this.db
        .prepare(`
          SELECT ${OUTBOX_SELECT_COLUMNS}
          FROM event_outbox
          WHERE id IN (${placeholders})
            AND locked_at=?
          ORDER BY id ASC
        `)
        .all(...idValues, lockedAt) as unknown as OutboxRow[];
    });
  }

  listOutboxForReplay(input: { sessionId: string; runId?: string | null; afterSeq?: number; limit?: number }): OutboxRow[] {
    const limit = input.limit ?? 100;
    const afterSeq = input.afterSeq ?? 0;
    if (input.runId) {
      return this.db
        .prepare(`
          SELECT ${OUTBOX_SELECT_COLUMNS}
          FROM event_outbox
          WHERE session_id=? AND run_id=? AND session_seq > ?
          ORDER BY session_seq ASC
          LIMIT ?
        `)
        .all(input.sessionId, input.runId, afterSeq, limit) as unknown as OutboxRow[];
    }
    return this.db
      .prepare(`
        SELECT ${OUTBOX_SELECT_COLUMNS}
        FROM event_outbox
        WHERE session_id=? AND session_seq > ?
        ORDER BY session_seq ASC
        LIMIT ?
      `)
      .all(input.sessionId, afterSeq, limit) as unknown as OutboxRow[];
  }

  getOutboxRow(id: number): OutboxRow | null {
    return this.loadOutboxRow(id);
  }

  listOutbox(input: ListOutboxInput = {}): PaginatedResult<OutboxRow> {
    const limit = normalizeLimit(input.limit, 100, 500);
    const offset = normalizeOffset(input.offset);
    const filters = buildOutboxFilters(input);
    const where = filters.clauses.length > 0 ? `WHERE ${filters.clauses.join(" AND ")}` : "";
    const total = this.db
      .prepare(`SELECT COUNT(*) AS total FROM event_outbox ${where}`)
      .get(...filters.values) as { total: number } | undefined;
    const items = this.db
      .prepare(`
        SELECT ${OUTBOX_SELECT_COLUMNS}
        FROM event_outbox
        ${where}
        ORDER BY id ASC
        LIMIT ? OFFSET ?
      `)
      .all(...filters.values, limit, offset) as unknown as OutboxRow[];
    const totalCount = numericCount(total?.total);
    return {
      items,
      total: totalCount,
      limit,
      offset,
      has_more: offset + items.length < totalCount,
    };
  }

  markOutboxDelivered(id: number): boolean {
    const result = this.db
      .prepare(`
        UPDATE event_outbox
        SET status='delivered', delivered_at=?, locked_at=NULL, last_error=NULL
        WHERE id=?
      `)
      .run(nowIso(), id);
    return Number(result.changes) > 0;
  }

  markOutboxRetrying(id: number, error: string, availableAt: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE event_outbox
        SET status='retrying', attempts=attempts + 1, available_at=?, locked_at=NULL, last_error=?
        WHERE id=?
      `)
      .run(availableAt, error, id);
    return Number(result.changes) > 0;
  }

  markOutboxFailed(id: number, error: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE event_outbox
        SET status='failed', attempts=attempts + 1, locked_at=NULL, last_error=?
        WHERE id=?
      `)
      .run(error, id);
    return Number(result.changes) > 0;
  }

  retryOutbox(id: number, availableAt = nowIso()): boolean {
    const result = this.db
      .prepare(`
        UPDATE event_outbox
        SET status='pending', available_at=?, locked_at=NULL, delivered_at=NULL, last_error=NULL
        WHERE id=? AND status IN ('failed', 'retrying')
      `)
      .run(availableAt, id);
    return Number(result.changes) > 0;
  }

  retryOutboxBatch(input: RetryOutboxBatchInput = {}): RetryOutboxResult {
    const statuses = normalizeOutboxStatuses(input.statuses, ["failed", "retrying"]);
    const availableAt = input.availableAt ?? nowIso();
    const ids = input.ids?.length
      ? uniquePositiveIntegers(input.ids)
      : this.selectOutboxIdsByStatus(statuses, normalizeLimit(input.limit, 100, 500));
    if (ids.length === 0) {
      return { matched: 0, retried: 0, ids: [] };
    }
    const placeholders = ids.map(() => "?").join(", ");
    const statusPlaceholders = statuses.map(() => "?").join(", ");
    const result = this.db
      .prepare(`
        UPDATE event_outbox
        SET status='pending', available_at=?, locked_at=NULL, delivered_at=NULL, last_error=NULL
        WHERE id IN (${placeholders}) AND status IN (${statusPlaceholders})
      `)
      .run(availableAt, ...ids, ...statuses);
    const retriedIds = this.db
      .prepare(`
        SELECT id
        FROM event_outbox
        WHERE id IN (${placeholders}) AND status='pending' AND available_at=?
        ORDER BY id ASC
      `)
      .all(...ids, availableAt) as Array<{ id: number }>;
    return {
      matched: ids.length,
      retried: Number(result.changes),
      ids: retriedIds.map((row) => Number(row.id)),
    };
  }

  private selectOutboxIdsByStatus(statuses: OutboxStatus[], limit: number): number[] {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
        SELECT id
        FROM event_outbox
        WHERE status IN (${placeholders})
        ORDER BY id ASC
        LIMIT ?
      `)
      .all(...statuses, limit) as Array<{ id: number }>;
    return rows.map((row) => Number(row.id));
  }

  deleteDeliveredOutbox(input: DeleteDeliveredOutboxInput): number {
    const limit = normalizeLimit(input.limit, 100, 10_000);
    const ids = this.db
      .prepare(`
        SELECT id
        FROM event_outbox
        WHERE status='delivered'
          AND COALESCE(delivered_at, created_at) < ?
        ORDER BY id ASC
        LIMIT ?
      `)
      .all(input.before, limit) as Array<{ id: number }>;
    if (ids.length === 0) {
      return 0;
    }
    const placeholders = ids.map(() => "?").join(", ");
    const result = this.db
      .prepare(`DELETE FROM event_outbox WHERE id IN (${placeholders})`)
      .run(...ids.map((row) => row.id));
    return Number(result.changes);
  }

  getOutboxStats(): EventOutboxStats {
    const row = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status='retrying' THEN 1 ELSE 0 END) AS retrying,
          SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status IN ('pending', 'retrying') AND locked_at IS NOT NULL THEN 1 ELSE 0 END) AS locked,
          SUM(CASE WHEN status IN ('pending', 'retrying') AND locked_at IS NULL AND available_at <= ? THEN 1 ELSE 0 END) AS ready,
          MIN(CASE WHEN status='pending' THEN created_at ELSE NULL END) AS oldest_pending_created_at,
          MIN(CASE WHEN status='retrying' THEN created_at ELSE NULL END) AS oldest_retrying_created_at,
          MIN(CASE WHEN status IN ('pending', 'retrying') THEN created_at ELSE NULL END) AS oldest_pending_or_retrying_created_at,
          MIN(CASE WHEN status='failed' THEN created_at ELSE NULL END) AS oldest_failed_created_at
        FROM event_outbox
      `)
      .get(nowIso()) as {
        total: number | null;
        pending: number | null;
        retrying: number | null;
        delivered: number | null;
        failed: number | null;
        locked: number | null;
        ready: number | null;
        oldest_pending_created_at: string | null;
        oldest_retrying_created_at: string | null;
        oldest_pending_or_retrying_created_at: string | null;
        oldest_failed_created_at: string | null;
      };
    const recentFailedErrors = this.db
      .prepare(`
        SELECT id, event_id, session_id, run_id, event_type, attempts, last_error, created_at
        FROM event_outbox
        WHERE status='failed'
        ORDER BY id DESC
        LIMIT 5
      `)
      .all() as unknown as EventOutboxErrorSummary[];
    return {
      total: numericCount(row.total),
      pending: numericCount(row.pending),
      retrying: numericCount(row.retrying),
      delivered: numericCount(row.delivered),
      failed: numericCount(row.failed),
      locked: numericCount(row.locked),
      ready: numericCount(row.ready),
      oldest_pending_created_at: row.oldest_pending_created_at,
      oldest_pending_age_seconds: ageSeconds(row.oldest_pending_created_at),
      oldest_retrying_created_at: row.oldest_retrying_created_at,
      oldest_retrying_age_seconds: ageSeconds(row.oldest_retrying_created_at),
      oldest_pending_or_retrying_created_at: row.oldest_pending_or_retrying_created_at,
      oldest_pending_or_retrying_age_seconds: ageSeconds(row.oldest_pending_or_retrying_created_at),
      oldest_failed_created_at: row.oldest_failed_created_at,
      oldest_failed_age_seconds: ageSeconds(row.oldest_failed_created_at),
      recent_failed_errors: recentFailedErrors,
    };
  }

  listRuns(sessionId: string, limit = 50): { items: RunInfo[]; total: number } {
    const rows = this.db
      .prepare(
        `
          SELECT run_id, session_id, entrypoint, status, task_summary,
                 user_id, agent_name, thread_key, parent_run_id, parent_call_id,
                 child_agent_id, final_message_id, created_at, updated_at
          FROM runs
          WHERE session_id=?
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(sessionId, limit) as unknown as RunRow[];
    const items = rows.map(rowToRun);
    return { items, total: items.length };
  }

  registerResource(input: {
    sessionId: string;
    path: string;
    resourceType: string;
    sourceTool?: string;
    runId?: string | null;
    stepId?: number | null;
    messageId?: string | null;
    subType?: string | null;
    title?: string | null;
    scope?: string | null;
    metadata?: Record<string, unknown>;
  }): {
    resource_id: string;
    session_id: string;
    path: string;
    scope: string;
    resource_type: string;
  } {
    const resourceId = randomUUID();
    const scope = input.scope ?? inferResourceScope({
      dataRoot: this.dataRoot,
      resourcePath: input.path,
      sessionMetadata: this.getSession(input.sessionId)?.metadata,
    });
    this.db
      .prepare(
        `
          INSERT INTO resources
          (resource_id, session_id, run_id, step_id, message_id,
           resource_type, sub_type, title, path, source_tool, scope, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        resourceId,
        input.sessionId,
        input.runId ?? null,
        input.stepId ?? null,
        input.messageId ?? null,
        input.resourceType,
        input.subType ?? null,
        input.title ?? null,
        input.path,
        input.sourceTool ?? "",
        scope,
        stringifyJson(input.metadata ?? {}),
      );
    return {
      resource_id: resourceId,
      session_id: input.sessionId,
      path: input.path,
      scope,
      resource_type: input.resourceType,
    };
  }

  listResources(sessionId: string, runId?: string | null, limit = 100): { items: ResourceInfo[]; total: number } {
    const rows = runId
      ? (this.db
          .prepare("SELECT * FROM resources WHERE session_id=? AND run_id=? ORDER BY created_at DESC LIMIT ?")
          .all(sessionId, runId, limit) as unknown as ResourceRow[])
      : (this.db
          .prepare("SELECT * FROM resources WHERE session_id=? ORDER BY created_at DESC LIMIT ?")
          .all(sessionId, limit) as unknown as ResourceRow[]);
    const items = rows.map(rowToResource);
    return { items, total: items.length };
  }

  attachResourceToStep(sessionId: string, runId: string, stepId: number, resourceId: string): void {
    this.db
      .prepare(
        `
          INSERT OR IGNORE INTO step_resources (step_id, resource_id, session_id, run_id)
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(stepId, resourceId, sessionId, runId);
  }

  listRunSteps(input: {
    runId?: string | null;
    messageId?: string | null;
    sessionId?: string | null;
    limit?: number;
  }): RunStepInfo[] {
    const rows = this.loadRunStepRows(input);
    const resourceRefsByStep = this.loadResourceRefs(rows.map((row) => row.id));
    return rows.map((row) => rowToRunStep(row, resourceRefsByStep.get(row.id) ?? []));
  }

  getToolCallRawResult(sessionId: string, callId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare(`
        SELECT ${RUN_STEP_SELECT_COLUMNS}
        FROM run_steps
        WHERE session_id=?
          AND step_type=?
          AND json_extract(payload, '$.kind')='tool'
          AND json_extract(payload, '$.phase')='end'
          AND json_extract(payload, '$.call_id')=?
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(sessionId, "execution.step", callId) as RunStepRow | undefined;
    if (!row) {
      return null;
    }
    const payload = parseJsonObject(row.payload);
    return {
      id: row.id,
      run_id: row.run_id,
      session_id: row.session_id,
      message_id: row.message_id,
      step_order: row.step_order,
      step_type: row.step_type,
      created_at: row.created_at,
      tool_name: asString(payload.tool_name),
      result_preview: payload.result_preview ?? payload.result,
      raw_result: payload.raw_result,
      raw_result_ref: payload.raw_result_ref ?? {},
      raw_result_available: Boolean(payload.raw_result_available ?? payload.raw_result !== undefined),
    };
  }

  private loadRunStepRows(input: {
    runId?: string | null;
    messageId?: string | null;
    sessionId?: string | null;
    limit?: number;
  }): RunStepRow[] {
    const limit = input.limit ?? 500;
    if (input.messageId) {
      if (input.sessionId) {
        return this.db
          .prepare(`
            SELECT ${RUN_STEP_SELECT_COLUMNS}
            FROM run_steps
            WHERE message_id=? AND session_id=?
            ORDER BY step_order ASC
            LIMIT ?
          `)
          .all(input.messageId, input.sessionId, limit) as unknown as RunStepRow[];
      }
      return this.db
        .prepare(`
          SELECT ${RUN_STEP_SELECT_COLUMNS}
          FROM run_steps
          WHERE message_id=?
          ORDER BY step_order ASC
          LIMIT ?
        `)
        .all(input.messageId, limit) as unknown as RunStepRow[];
    }

    if (input.runId) {
      if (input.sessionId) {
        return this.db
          .prepare(`
            SELECT ${RUN_STEP_SELECT_COLUMNS}
            FROM run_steps
            WHERE run_id=? AND session_id=?
            ORDER BY step_order ASC
            LIMIT ?
          `)
          .all(input.runId, input.sessionId, limit) as unknown as RunStepRow[];
      }
      return this.db
        .prepare(`
          SELECT ${RUN_STEP_SELECT_COLUMNS}
          FROM run_steps
          WHERE run_id=?
          ORDER BY step_order ASC
          LIMIT ?
        `)
        .all(input.runId, limit) as unknown as RunStepRow[];
    }

    return [];
  }

  private loadResourceRefs(stepIds: number[]): Map<number, Array<{ resource_id: string }>> {
    const refs = new Map<number, Array<{ resource_id: string }>>();
    if (stepIds.length === 0) {
      return refs;
    }
    const placeholders = stepIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT step_id, resource_id FROM step_resources WHERE step_id IN (${placeholders})`)
      .all(...stepIds) as unknown as Array<{ step_id: number; resource_id: string }>;
    for (const row of rows) {
      const current = refs.get(row.step_id) ?? [];
      current.push({ resource_id: row.resource_id });
      refs.set(row.step_id, current);
    }
    return refs;
  }

  private createTransactionFacade(): ConversationStoreTransaction {
    return {
      addMessage: (input) => this.addMessageInTransaction(input),
      addRunStep: (input) => this.addRunStepInTransaction(input),
      updateRunStepsMessageId: (sessionId, runId, messageId) => this.updateRunStepsMessageId(sessionId, runId, messageId),
      updateRunStatus: (runId, sessionId, status, finalMessageId = null) =>
        this.updateRunStatus(runId, sessionId, status, finalMessageId),
      nextSessionSeq: (sessionId) => this.nextSessionSeqInTransaction(sessionId),
      appendOutbox: (input) => this.appendOutboxInTransaction(input),
    };
  }

  private nextSessionSeqInTransaction(sessionId: string): number {
    this.db
      .prepare(`
        INSERT INTO session_event_seq (session_id, last_seq)
        VALUES (?, 0)
        ON CONFLICT(session_id) DO NOTHING
      `)
      .run(sessionId);
    this.db.prepare("UPDATE session_event_seq SET last_seq=last_seq + 1 WHERE session_id=?").run(sessionId);
    const row = this.db
      .prepare("SELECT last_seq FROM session_event_seq WHERE session_id=?")
      .get(sessionId) as { last_seq: number } | undefined;
    if (!row) {
      throw new Error(`Session event sequence update failed: ${sessionId}`);
    }
    return Number(row.last_seq);
  }

  private appendOutboxInTransaction(input: AppendOutboxInput): OutboxRow {
    const eventId = input.eventId ?? randomUUID();
    this.db.prepare("INSERT OR IGNORE INTO sessions (session_id, metadata) VALUES (?, ?)").run(input.sessionId, "{}");
    const sessionSeq = input.sessionSeq ?? this.nextSessionSeqInTransaction(input.sessionId);
    const result = this.db
      .prepare(`
        INSERT INTO event_outbox (
          event_id, session_id, run_id, session_seq, event_type, aggregate_type,
          aggregate_id, payload, available_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        eventId,
        input.sessionId,
        input.runId ?? null,
        sessionSeq,
        input.eventType,
        input.aggregateType,
        input.aggregateId,
        stringifyJson(input.payload),
        input.availableAt ?? nowIso(),
      );
    const row = this.loadOutboxRow(Number(result.lastInsertRowid));
    if (!row) {
      throw new Error(`Outbox insert failed: ${eventId}`);
    }
    return row;
  }

  private loadOutboxRow(id: number): OutboxRow | null {
    const row = this.db
      .prepare(`SELECT ${OUTBOX_SELECT_COLUMNS} FROM event_outbox WHERE id=?`)
      .get(id) as OutboxRow | undefined;
    return row ?? null;
  }

  private withTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

}

function numericCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeLimit(value: number | null | undefined, defaultValue: number, maxValue: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.min(maxValue, Math.max(1, Math.floor(value)));
}

function normalizeOffset(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function buildOutboxFilters(input: ListOutboxInput): { clauses: string[]; values: Array<string | number> } {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  const statuses = normalizeOutboxStatuses(input.statuses, []);
  if (statuses.length > 0) {
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    values.push(...statuses);
  }
  const sessionId = normalizeNonEmptyString(input.sessionId);
  if (sessionId) {
    clauses.push("session_id=?");
    values.push(sessionId);
  }
  const runId = normalizeNonEmptyString(input.runId);
  if (runId) {
    clauses.push("run_id=?");
    values.push(runId);
  }
  return { clauses, values };
}

function normalizeOutboxStatuses(values: OutboxStatus[] | undefined, defaultStatuses: OutboxStatus[]): OutboxStatus[] {
  if (!values || values.length === 0) {
    return [...defaultStatuses];
  }
  const statuses: OutboxStatus[] = [];
  for (const value of values) {
    if (!isOutboxStatus(value)) {
      continue;
    }
    if (!statuses.includes(value)) {
      statuses.push(value);
    }
  }
  return statuses;
}

function isOutboxStatus(value: string): value is OutboxStatus {
  return value === "pending" || value === "retrying" || value === "delivered" || value === "failed";
}

function uniquePositiveIntegers(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.floor(value)).filter((value) => Number.isSafeInteger(value) && value > 0))];
}

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function ageSeconds(timestamp: string | null): number | null {
  if (!timestamp) {
    return null;
  }
  const parsed = Date.parse(timestamp.includes("T") ? timestamp : `${timestamp}Z`);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
