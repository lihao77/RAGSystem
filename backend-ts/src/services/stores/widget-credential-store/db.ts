import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export type WidgetCredentialDb = import("node:sqlite").DatabaseSync;

/**
 * widget 凭证存储底层 SQLite 连接。
 *
 * 复用主库同一 dbPath（WAL 允许多连接并发），新建 widget_apps / widget_tokens 两表；
 * 独立句柄，RuntimeContainer.close 时单独释放。DDL 幂等，与 conversation-store 的表互不冲突。
 */
export function createWidgetCredentialDb(options: { dbPath: string }): WidgetCredentialDb {
  if (options.dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
  }
  const db = new DatabaseSync(options.dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS widget_apps (
      app_key         TEXT PRIMARY KEY,
      secret_hash     TEXT NOT NULL,
      secret_prefix   TEXT NOT NULL,
      display_name    TEXT NOT NULL,
      allowed_origins TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at      TEXT
    );
    CREATE TABLE IF NOT EXISTS widget_tokens (
      jti        TEXT PRIMARY KEY,
      app_key    TEXT NOT NULL,
      issued_at  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_widget_tokens_app_key ON widget_tokens(app_key);
  `);
  return db;
}
