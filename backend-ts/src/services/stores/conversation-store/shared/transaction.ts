import type { ConversationDb } from "./db.js";

/**
 * 在单个 SQLite 事务中执行 operation（BEGIN/COMMIT/ROLLBACK）。
 * 迁移自原 ConversationStore.withTransaction，逻辑零改动。
 */
export function runInTransaction<T>(db: ConversationDb, operation: () => T): T {
  db.exec("BEGIN");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
