import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { runMigrations } from "../migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

/** 共享 SQLite 句柄类型（node:sqlite 实验性 API）。 */
export type ConversationDb = import("node:sqlite").DatabaseSync;

export interface ConversationDbHandle {
  readonly db: ConversationDb;
  readonly dataRoot: string;
}

/**
 * 创建并初始化会话存储底层 SQLite 连接。
 * 迁移自原 ConversationStore constructor + 模块底部 createRequire/DatabaseSync，逻辑零改动。
 */
export function createConversationDb(options: {
  dbPath: string;
  dataRoot?: string | undefined;
}): ConversationDbHandle {
  if (!options.dataRoot?.trim()) {
    throw new Error("createConversationDb 必须传入已解析的 dataRoot");
  }
  const dataRoot = path.resolve(options.dataRoot);
  if (options.dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
  }
  const db = new DatabaseSync(options.dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // backend 多个 store 聚合（conversation/widget/vector 各自连接）同操作 ragsystem.db（B2:SDK store 已删）。
  // WAL 下并发写事务靠 busy_timeout 让后续方等待而非立即抛 SQLITE_BUSY。
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    runMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return { db, dataRoot };
}
