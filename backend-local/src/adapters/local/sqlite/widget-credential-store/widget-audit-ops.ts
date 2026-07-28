import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { WidgetCredentialDb } from "./db.js";

export interface WidgetAudit {
  id: number;
  app_key: string;
  action: string;
  actor: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

interface WidgetAuditRow extends Omit<WidgetAudit, "detail"> {
  detail_json: string | null;
}

export class WidgetAuditOps {
  constructor(private readonly db: WidgetCredentialDb) {}

  record(tenantId: TenantId, input: { app_key: string; action: string; actor: string; detail?: Record<string, unknown> }): void {
    const result = this.db.prepare(`
      INSERT INTO widget_audit (app_key, action, actor, detail_json)
      SELECT app_key, ?, ?, ?
      FROM widget_apps
      WHERE tenant_id=? AND app_key=?
    `).run(input.action, input.actor, input.detail ? JSON.stringify(input.detail) : null, tenantId, input.app_key);
    if (Number(result.changes) !== 1) throw new Error("widget app 不存在");
  }

  list(tenantId: TenantId, appKey: string, limit = 100, offset = 0): WidgetAudit[] {
    const rows = this.db.prepare(`
      SELECT audit.id, audit.app_key, audit.action, audit.actor, audit.detail_json, audit.created_at
      FROM widget_audit audit
      JOIN widget_apps app ON app.app_key=audit.app_key
      WHERE app.tenant_id=? AND audit.app_key=?
      ORDER BY audit.id DESC
      LIMIT ? OFFSET ?
    `).all(tenantId, appKey, limit, offset) as unknown as WidgetAuditRow[];
    return rows.map((row) => ({
      id: row.id,
      app_key: row.app_key,
      action: row.action,
      actor: row.actor,
      detail: row.detail_json ? JSON.parse(row.detail_json) as Record<string, unknown> : null,
      created_at: row.created_at,
    }));
  }
}
