import { describe, expect, it } from "vitest";

import { createTenantId, createUserId, type RequestIdentity } from "../../../src/identity/types.js";
import { POSTGRES_WS_TICKET_MIGRATIONS } from "../../../src/adapters/saas/postgres/ws-ticket-schema.js";
import { PostgresWsTicketService } from "../../../src/adapters/saas/postgres/ws-ticket-repository.js";
import type { PostgresMemoryExecutor, PostgresQueryResult } from "../../../src/adapters/saas/postgres/memory-repository.js";

interface TicketRow extends Record<string, unknown> {
  ticket_hash: string;
  tenant_id: string;
  user_id: string;
  role: string;
  permissions: string[];
  platform_role: string | null;
  widget_app_key: string | null;
  session_id: string;
  expires_at: string;
}

class TicketExecutor implements PostgresMemoryExecutor {
  readonly rows = new Map<string, TicketRow>();
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    if (sql.startsWith("DELETE FROM websocket_tickets WHERE expires_at")) {
      const now = Date.now();
      for (const [key, row] of this.rows) if (Date.parse(row.expires_at) <= now) this.rows.delete(key);
      return { rows: [] };
    }
    if (sql.startsWith("SELECT COUNT(*)::text")) {
      const count = [...this.rows.values()].filter((row) => row.tenant_id === params[0]).length;
      return { rows: [{ count: String(count) }] as unknown as Row[] };
    }
    if (sql.startsWith("INSERT INTO websocket_tickets")) {
      const record = {
        ticket_hash: String(params[0]), tenant_id: String(params[1]), user_id: String(params[2]),
        role: String(params[3]), permissions: JSON.parse(String(params[4])) as string[],
        platform_role: params[5] == null ? null : String(params[5]),
        widget_app_key: params[6] == null ? null : String(params[6]),
        session_id: String(params[7]),
        expires_at: new Date(Date.now() + Number(params[8])).toISOString(),
      } satisfies TicketRow;
      this.rows.set(String(params[0]), record);
      return { rows: [{ expires_at: record.expires_at }] as unknown as Row[], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM websocket_tickets WHERE ticket_hash")) {
      const row = this.rows.get(String(params[0]));
      this.rows.delete(String(params[0]));
      return { rows: row ? [row] as unknown as Row[] : [] };
    }
    return { rows: [] };
  }
  transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> { return fn(this); }
}

const identity: RequestIdentity = {
  tenantId: createTenantId("tnt_ws_shared"), userId: createUserId("usr_ws_shared"),
  role: "owner", permissions: ["session:read"],
};

describe("PostgreSQL websocket tickets", () => {
  it("defines a shared expiring ticket table", () => {
    expect(POSTGRES_WS_TICKET_MIGRATIONS[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS websocket_tickets");
    expect(POSTGRES_WS_TICKET_MIGRATIONS[0]?.sql).toContain("ticket_hash TEXT PRIMARY KEY");
    expect(POSTGRES_WS_TICKET_MIGRATIONS[0]?.sql).toContain("expires_at TIMESTAMPTZ NOT NULL");
    expect(POSTGRES_WS_TICKET_MIGRATIONS[1]).toMatchObject({ version: 2, name: "widget-app-key" });
    expect(POSTGRES_WS_TICKET_MIGRATIONS[1]?.sql).toContain("ADD COLUMN IF NOT EXISTS widget_app_key");
  });

  it("issues on one process and atomically consumes on another", async () => {
    const executor = new TicketExecutor();
    const issuer = new PostgresWsTicketService(executor);
    const consumer = new PostgresWsTicketService(executor);
    const issued = await issuer.issue(identity, "session-1");

    await expect(consumer.consume(issued.ticket, "session-1")).resolves.toEqual(identity);
    await expect(issuer.consume(issued.ticket, "session-1")).rejects.toThrow("invalid or expired");
  });

  it("invalidates a ticket consumed against the wrong session", async () => {
    const executor = new TicketExecutor();
    const service = new PostgresWsTicketService(executor);
    const issued = await service.issue(identity, "session-1");
    await expect(service.consume(issued.ticket, "session-2")).rejects.toThrow("session mismatch");
    await expect(service.consume(issued.ticket, "session-1")).rejects.toThrow("invalid or expired");
  });
});
