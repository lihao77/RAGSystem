/**
 * 内置 store —— node:sqlite 实现（设计稿 §5）。
 *
 * 单一实现：node:sqlite DatabaseSync，按 dataRoot（默认 ~/.ragsystem）在其下建 conversation.db。
 * schema 与 backend-ts 逐字对齐（同驱动、同 WAL/foreign_keys），故 backend-ts 直读同库兼容。
 * 自带事务：runInTransaction 用 BEGIN/COMMIT/ROLLBACK，tx 内 addMessage/addRunStep/... 同事务原子。
 *
 * SDK MessageInfo/RunRecord/RunStepRecord 用 camelCase（profile 化后的领域类型）；
 * SQL 行是 snake_case，经 rowTo* / *ToRow 在边界转换。
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import type {
  AddMessageInput,
  AddRunStepInput,
  CreateRunInput,
  InsertCompressionMessageInput,
  RuntimeStore,
  RuntimeTx,
} from "../contracts.js";
import type { MessageInfo, MessageRole, RunRecord, RunStepRecord, RunStatus } from "../types.js";
import { STORE_SCHEMA_SQL } from "./schema.js";
import { decodeChatFields, encodeChatFields, type ChatMessageFields } from "./chat-codec.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

/** node:sqlite 数据库句柄（实验性 API）。 */
export type StoreDb = import("node:sqlite").DatabaseSync;

interface MessageRow {
  seq: number;
  id: string;
  session_id: string;
  role: string;
  content: string;
  metadata: string | null;
  thread_key: string;
  child_agent_id: string | null;
  created_at: string;
}

interface RunRow {
  run_id: string;
  session_id: string;
  status: string;
  thread_key: string;
  parent_run_id: string | null;
  parent_call_id: string | null;
  final_message_id: string | null;
  child_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RunStepRow {
  id: number;
  run_id: string;
  session_id: string;
  message_id: string | null;
  step_order: number;
  step_type: string;
  payload: string;
  created_at: string;
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToMessage(row: MessageRow): MessageInfo {
  const metadata = parseJsonObject(row.metadata);
  const { toolCalls, toolCallId, name } = decodeChatFields(metadata);
  const info: MessageInfo = {
    id: row.id,
    seq: row.seq,
    sessionId: row.session_id,
    role: row.role as MessageRole,
    content: row.content,
    metadata,
    createdAt: row.created_at,
    threadKey: row.thread_key ?? "root",
    childAgentId: row.child_agent_id,
  };
  if (toolCalls) {
    info.toolCalls = toolCalls;
  }
  if (toolCallId) {
    info.toolCallId = toolCallId;
  }
  if (name) {
    info.name = name;
  }
  return info;
}

function rowToRun(row: RunRow): RunRecord {
  return {
    id: row.run_id,
    sessionId: row.session_id,
    status: row.status as RunStatus,
    rootCallId: "",
    threadKey: row.thread_key,
    parentCallId: row.parent_call_id,
    finalMessageId: row.final_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRunStep(row: RunStepRow): RunStepRecord {
  return {
    id: String(row.id),
    sessionId: row.session_id,
    runId: row.run_id,
    stepType: row.step_type,
    payload: parseJsonObject(row.payload),
    messageId: row.message_id,
    createdAt: row.created_at,
  };
}

class SqliteTx implements RuntimeTx {
  constructor(private readonly store: SqliteRuntimeStore) {}

  addMessage(input: AddMessageInput): MessageInfo {
    return this.store.addMessageInternal(input);
  }

  addRunStep(input: AddRunStepInput): RunStepRecord {
    return this.store.addRunStepInternal(input);
  }

  updateRunStepsMessageId(sessionId: string, runId: string, messageId: string): number {
    return this.store.updateRunStepsMessageIdInternal(sessionId, runId, messageId);
  }

  insertCompressionMessage(input: InsertCompressionMessageInput): MessageInfo {
    return this.store.insertCompressionMessageInternal(input);
  }
}

export interface SqliteStoreOptions {
  dataRoot?: string;
  dbName?: string;
  /** 显式 db 文件路径，优先于 dataRoot+dbName（消费端共享既有库时用）。 */
  dbPath?: string;
}

export class SqliteRuntimeStore implements RuntimeStore {
  private readonly db: StoreDb;
  readonly dataRoot: string;

  constructor(options: SqliteStoreOptions = {}) {
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
    const dbPath = options.dbPath ?? path.join(this.dataRoot, options.dbName ?? "conversation.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    // 消费端可能开第二个连接同操作此库（backend ConversationStore）。WAL 下两写事务不能并发，
    // busy_timeout 让第二方等待而非立即抛 SQLITE_BUSY。
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(STORE_SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  runInTransaction<T>(fn: (tx: RuntimeTx) => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn(new SqliteTx(this));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listMessages(sessionId: string, threadKey?: string, limit?: number): MessageInfo[] {
    const sqlLimit = limit ?? 10_000;
    const resolvedThread = threadKey?.trim() || null;
    const rows = this.db
      .prepare(
        `SELECT seq, id, session_id, role, content, metadata, thread_key, child_agent_id, created_at
         FROM messages
         WHERE session_id=? AND (? IS NULL OR thread_key=?)
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(sessionId, resolvedThread, resolvedThread, sqlLimit) as unknown as MessageRow[];
    return rows.map(rowToMessage).reverse();
  }

  getMessageById(sessionId: string, messageId: string): MessageInfo | null {
    const row = this.db
      .prepare(
        `SELECT seq, id, session_id, role, content, metadata, thread_key, child_agent_id, created_at
         FROM messages WHERE session_id=? AND id=?`,
      )
      .get(sessionId, messageId) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  createRun(input: CreateRunInput): void {
    // 先查后插：委派等场景消费端可能已预创建 run（带血缘），此处幂等跳过不覆盖；SDK 先建时消费端后插也不冲突。
    if (this.getRun(input.id) !== null) {
      return;
    }
    // sessions 是 runs/messages 的外键父表；INSERT OR IGNORE 保证调用顺序无关（createRun 先于
    // addMessage 也能跑），对齐 addMessageInternal 的同名兜底。
   this.db
     .prepare("INSERT OR IGNORE INTO sessions (session_id, metadata) VALUES (?, ?)")
     .run(input.sessionId, "{}");
   this.db
     .prepare(
       `INSERT INTO runs (run_id, session_id, status, thread_key, parent_call_id)
        VALUES (?, ?, ?, ?, ?)`,
     )
     .run(input.id, input.sessionId, "running", input.threadKey, input.parentCallId);
    // 可选字段（agentName/entrypoint/taskSummary/userId）补填：投影算死后透传，
    // 缺省不落（NULL），SDK standalone 用例不传即空。
    const patch = this.db.prepare(
      `UPDATE runs SET agent_name=?, entrypoint=?, task_summary=?, user_id=? WHERE run_id=?`,
    );
    patch.run(
      input.agentName ?? null,
      input.entrypoint ?? null,
      input.taskSummary ?? null,
      input.userId ?? null,
      input.id,
    );
 }

  getRun(runId: string): RunRecord | null {
    const row = this.db
      .prepare(
        `SELECT run_id, session_id, status, thread_key, parent_call_id,
                final_message_id, child_agent_id, created_at, updated_at
         FROM runs WHERE run_id=?`,
      )
      .get(runId) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  updateRunStatus(runId: string, status: RunStatus, finalMessageId?: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE runs SET status=?, final_message_id=?, updated_at=CURRENT_TIMESTAMP WHERE run_id=?`,
      )
      .run(status, finalMessageId ?? null, runId);
    return Number(result.changes) > 0;
  }

  addMessageInternal(input: AddMessageInput): MessageInfo {
    const messageId = input.messageId ?? randomUUID();
    const threadKey = (input.threadKey ?? "root").trim() || "root";
    const childAgentId = input.childAgentId ?? null;
    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}), thread_key: threadKey };
    if (childAgentId) {
      metadata.child_agent_id = childAgentId;
    }
    const fields: ChatMessageFields = {};
    if (input.toolCalls) {
      fields.toolCalls = input.toolCalls;
    }
    if (input.toolCallId) {
      fields.toolCallId = input.toolCallId;
    }
    if (input.name) {
      fields.name = input.name;
    }
    const persistedMetadata = encodeChatFields(metadata, fields);
    this.db
      .prepare("INSERT OR IGNORE INTO sessions (session_id, metadata) VALUES (?, ?)")
      .run(input.sessionId, "{}");
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, metadata, thread_key, child_agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId,
        input.sessionId,
        input.role,
        input.content,
        JSON.stringify(persistedMetadata),
        threadKey,
        childAgentId,
      );
    this.db
      .prepare("UPDATE sessions SET updated_at=CURRENT_TIMESTAMP WHERE session_id=?")
      .run(input.sessionId);
    const row = this.db
      .prepare(
        `SELECT seq, id, session_id, role, content, metadata, thread_key, child_agent_id, created_at
         FROM messages WHERE id=?`,
      )
      .get(messageId) as MessageRow | undefined;
    if (!row) {
      throw new Error(`Message insert failed: ${messageId}`);
    }
    return rowToMessage({ ...row, session_id: input.sessionId });
  }

  addRunStepInternal(input: AddRunStepInput): RunStepRecord {
    const orderRow = this.db
      .prepare(
        "SELECT COALESCE(MAX(step_order), 0) + 1 AS next_order FROM run_steps WHERE session_id=? AND run_id=?",
      )
      .get(input.sessionId, input.runId) as { next_order: number };
    const stepOrder = Number(orderRow.next_order) || 1;
    const result = this.db
      .prepare(
        `INSERT INTO run_steps (run_id, session_id, message_id, step_order, step_type, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.sessionId,
        input.messageId ?? null,
        stepOrder,
        input.stepType,
        JSON.stringify(input.payload),
      );
    return {
      id: String(Number(result.lastInsertRowid)),
      sessionId: input.sessionId,
      runId: input.runId,
      stepType: input.stepType,
      payload: { ...input.payload, stepOrder },
      messageId: input.messageId ?? null,
      createdAt: new Date().toISOString(),
    };
  }

  updateRunStepsMessageIdInternal(sessionId: string, runId: string, messageId: string): number {
    const result = this.db
      .prepare("UPDATE run_steps SET message_id=? WHERE session_id=? AND run_id=? AND message_id IS NULL")
      .run(messageId, sessionId, runId);
    return Number(result.changes);
  }

  insertCompressionMessageInternal(input: InsertCompressionMessageInput): MessageInfo {
    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}), compression: true };
    if (input.replacesUpToSeq !== undefined) {
      metadata.replaces_up_to_seq = input.replacesUpToSeq;
    }
    const messageInput: AddMessageInput = {
      sessionId: input.sessionId,
      role: "assistant",
      content: input.content,
      metadata,
      childAgentId: null,
    };
    if (input.threadKey !== undefined) {
      messageInput.threadKey = input.threadKey;
    }
    return this.addMessageInternal(messageInput);
  }
}
