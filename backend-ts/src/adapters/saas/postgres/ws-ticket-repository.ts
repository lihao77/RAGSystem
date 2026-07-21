import { randomBytes } from "node:crypto";

import { createTenantId, createUserId, type RequestIdentity } from "../../../identity/types.js";
import { AuthError } from "../../../services/identity/auth-error.js";
import { hashWsTicket, type WsTicketService } from "../../../services/runtime/ws-ticket-service.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

export interface PostgresWsTicketServiceOptions {
  ttlMs?: number;
  maxPendingPerTenant?: number;
}

export class PostgresWsTicketService implements WsTicketService {
  private readonly ttlMs: number;
  private readonly maxPendingPerTenant: number;

  constructor(private readonly executor: PostgresMemoryExecutor, options: PostgresWsTicketServiceOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxPendingPerTenant = options.maxPendingPerTenant ?? 10_000;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error("WS ticket ttlMs must be positive");
    if (!Number.isSafeInteger(this.maxPendingPerTenant) || this.maxPendingPerTenant <= 0) throw new Error("WS ticket maxPendingPerTenant must be a positive integer");
  }

  async issue(identity: RequestIdentity, sessionId: string): Promise<{ ticket: string; expires_at: number }> {
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = await this.executor.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ws-ticket:${identity.tenantId}`]);
      await tx.query("DELETE FROM websocket_tickets WHERE expires_at <= CURRENT_TIMESTAMP");
      const count = await tx.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM websocket_tickets WHERE tenant_id=$1 AND expires_at>CURRENT_TIMESTAMP",
        [identity.tenantId],
      );
      if (Number(count.rows[0]?.count ?? 0) >= this.maxPendingPerTenant) {
        throw new AuthError("too many pending websocket tickets");
      }
      const inserted = await tx.query<{ expires_at: string }>(
        `INSERT INTO websocket_tickets
          (ticket_hash,tenant_id,user_id,role,permissions,platform_role,session_id,expires_at)
         VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,CURRENT_TIMESTAMP+($8::double precision*INTERVAL '1 millisecond'))
         RETURNING expires_at`,
        [hashWsTicket(ticket), identity.tenantId, identity.userId, identity.role, JSON.stringify(identity.permissions), identity.platformRole ?? null, sessionId, this.ttlMs],
      );
      if (!inserted.rows[0]) throw new Error("websocket ticket insert returned no row");
      return new Date(inserted.rows[0].expires_at);
    });
    return { ticket, expires_at: Math.floor(expiresAt.getTime() / 1000) };
  }

  async consume(ticket: string, sessionId: string): Promise<RequestIdentity> {
    if (!ticket) throw new AuthError("missing websocket ticket");
    const result = await this.executor.query(
      `DELETE FROM websocket_tickets WHERE ticket_hash=$1 AND expires_at>CURRENT_TIMESTAMP
       RETURNING tenant_id,user_id,role,permissions,platform_role,session_id,expires_at`,
      [hashWsTicket(ticket)],
    );
    const row = result.rows[0];
    if (!row) throw new AuthError("invalid or expired websocket ticket");
    if (String(row.session_id) !== sessionId) throw new AuthError("websocket ticket session mismatch");
    const permissions = Array.isArray(row.permissions) ? row.permissions.map(String) : [];
    return {
      tenantId: createTenantId(String(row.tenant_id)),
      userId: createUserId(String(row.user_id)),
      role: String(row.role),
      permissions,
      ...(row.platform_role === "admin" ? { platformRole: "admin" as const } : {}),
    };
  }

  close(): void {}
}
