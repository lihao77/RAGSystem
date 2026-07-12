import { createWidgetCredentialDb, type WidgetCredentialDb } from "./db.js";
import { WidgetCredentialOps, type CreatedWidgetApp, type WidgetApp } from "./widget-credential-ops.js";
import { WidgetAuditOps, type WidgetAudit } from "./widget-audit-ops.js";

/**
 * widget 凭证存储 facade（无主类）：共享 SQLite 句柄 + WidgetCredentialOps 聚合根。
 * 类比 createConversationStore 的工厂模式，但 widget 凭证域只有单一 ops，结构更简。
 */
export interface WidgetCredentialStore {
  readonly ops: WidgetCredentialOps;
  readonly audit: WidgetAuditOps;
  /** 启动过期 token 周期清理（与 outboxDispatcher 同生命周期，幂等）。首次立即清一次。 */
  startPruning(intervalMs?: number): void;
  /** 停止周期清理（不关 db）。 */
  stop(): void;
  close(): void;
}

const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

export function createWidgetCredentialStore(options: { dbPath: string }): WidgetCredentialStore {
  const db: WidgetCredentialDb = createWidgetCredentialDb({ dbPath: options.dbPath });
  const ops = new WidgetCredentialOps(db);
  const audit = new WidgetAuditOps(db);
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  const prune = (): void => {
    ops.pruneExpiredTokens(Math.floor(Date.now() / 1000));
  };
  return {
    ops,
    audit,
    startPruning(intervalMs) {
      if (pruneTimer) {
        return;
      }
      prune();
      pruneTimer = setInterval(prune, intervalMs ?? PRUNE_INTERVAL_MS);
    },
    stop() {
      if (pruneTimer) {
        clearInterval(pruneTimer);
        pruneTimer = null;
      }
    },
    close: () => {
      if (pruneTimer) {
        clearInterval(pruneTimer);
        pruneTimer = null;
      }
      db.close();
    },
  };
}

export type { WidgetApp, CreatedWidgetApp, WidgetAudit, WidgetCredentialDb };
export { WidgetAuditOps, WidgetCredentialOps };
