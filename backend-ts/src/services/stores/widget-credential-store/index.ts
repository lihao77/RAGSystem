import { createWidgetCredentialDb, type WidgetCredentialDb } from "./db.js";
import { WidgetCredentialOps, type CreatedWidgetApp, type WidgetApp } from "./widget-credential-ops.js";

/**
 * widget 凭证存储 facade（无主类）：共享 SQLite 句柄 + WidgetCredentialOps 聚合根。
 * 类比 createConversationStore 的工厂模式，但 widget 凭证域只有单一 ops，结构更简。
 */
export interface WidgetCredentialStore {
  readonly ops: WidgetCredentialOps;
  close(): void;
}

export function createWidgetCredentialStore(options: { dbPath: string }): WidgetCredentialStore {
  const db: WidgetCredentialDb = createWidgetCredentialDb({ dbPath: options.dbPath });
  const ops = new WidgetCredentialOps(db);
  return {
    ops,
    close: () => db.close(),
  };
}

export type { WidgetApp, CreatedWidgetApp, WidgetCredentialDb };
export { WidgetCredentialOps };
