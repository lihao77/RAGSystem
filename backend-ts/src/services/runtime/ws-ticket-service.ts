import { createHash, randomBytes } from "node:crypto";

import type { RequestIdentity } from "../../identity/types.js";
import { AuthError } from "../identity/auth-error.js";

interface WsTicketRecord {
  identity: RequestIdentity;
  sessionId: string;
  expiresAt: number;
}

export interface WsTicketService {
  issue(identity: RequestIdentity, sessionId: string): { ticket: string; expires_at: number } | Promise<{ ticket: string; expires_at: number }>;
  consume(ticket: string, sessionId: string): RequestIdentity | Promise<RequestIdentity>;
  close(): void | Promise<void>;
}

export interface WsTicketServiceOptions {
  ttlMs?: number;
  maxPending?: number;
  now?: () => number;
}

export function createWsTicketService(options: WsTicketServiceOptions = {}): WsTicketService {
  const ttlMs = options.ttlMs ?? 60_000;
  const maxPending = options.maxPending ?? 10_000;
  const now = options.now ?? Date.now;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("WS ticket ttlMs 必须为正数");
  if (!Number.isSafeInteger(maxPending) || maxPending <= 0) throw new Error("WS ticket maxPending 必须为正整数");
  const pending = new Map<string, WsTicketRecord>();

  const prune = (currentTime: number): void => {
    for (const [key, record] of pending) {
      if (record.expiresAt <= currentTime) pending.delete(key);
    }
  };

  return {
    issue(identity: RequestIdentity, sessionId: string) {
      const currentTime = now();
      prune(currentTime);
      if (pending.size >= maxPending) throw new AuthError("too many pending websocket tickets");
      const ticket = randomBytes(32).toString("base64url");
      const expiresAt = currentTime + ttlMs;
      pending.set(hashWsTicket(ticket), {
        identity: { ...identity, permissions: [...identity.permissions] },
        sessionId,
        expiresAt,
      });
      return { ticket, expires_at: Math.floor(expiresAt / 1000) };
    },
    consume(ticket: string, sessionId: string) {
      if (!ticket) throw new AuthError("missing websocket ticket");
      const key = hashWsTicket(ticket);
      const record = pending.get(key);
      pending.delete(key);
      if (!record || record.expiresAt <= now()) throw new AuthError("invalid or expired websocket ticket");
      if (record.sessionId !== sessionId) throw new AuthError("websocket ticket session mismatch");
      return { ...record.identity, permissions: [...record.identity.permissions] };
    },
    close() {
      pending.clear();
    },
  };
}

export function hashWsTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("base64url");
}
