import type { WidgetCredentialDb } from "./db.js";

export interface WidgetAudit { id: number; app_key: string; action: string; actor: string; detail: Record<string, unknown> | null; created_at: string; }
interface WidgetAuditRow extends Omit<WidgetAudit, "detail"> { detail_json: string | null; }

export class WidgetAuditOps {
  constructor(private readonly db: WidgetCredentialDb) {}
  record(input: { app_key: string; action: string; actor: string; detail?: Record<string, unknown> }): void {
    this.db.prepare("INSERT INTO widget_audit (app_key, action, actor, detail_json) VALUES (?, ?, ?, ?)").run(input.app_key, input.action, input.actor, input.detail ? JSON.stringify(input.detail) : null);
  }
  list(app_key: string, limit = 100, offset = 0): WidgetAudit[] {
    const rows = this.db.prepare("SELECT id, app_key, action, actor, detail_json, created_at FROM widget_audit WHERE app_key=? ORDER BY id DESC LIMIT ? OFFSET ?").all(app_key, limit, offset) as unknown as WidgetAuditRow[];
    return rows.map((row) => ({ id: row.id, app_key: row.app_key, action: row.action, actor: row.actor, detail: row.detail_json ? JSON.parse(row.detail_json) as Record<string, unknown> : null, created_at: row.created_at }));
  }
}
