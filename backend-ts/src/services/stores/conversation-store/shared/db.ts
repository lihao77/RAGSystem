import fs from "node:fs";
import os from "node:os";
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
  const dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
  if (options.dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
  }
  const db = new DatabaseSync(options.dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // SDK store 归位后，backend ConversationStore 与 SDK SqliteRuntimeStore 是两个独立连接同操作
  // 同一 ragsystem.db。WAL 下两写事务不能并发，busy_timeout 让第二方等待而非立即抛 SQLITE_BUSY。
  db.exec("PRAGMA busy_timeout = 5000");
  runMigrations(db);
  return { db, dataRoot };
}
