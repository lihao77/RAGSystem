import type { Envelope } from "@ragsystem/agent-protocol";

/**
 * widget WS 连接参数。sessionId/token 由 mount 注入；cursor 来自最近收到的 envelope seq。
 */
export interface WidgetWsUrlOptions {
  /** 后端 origin，如 https://api.host.com（含协议）。 */
  backendBase: string;
  sessionId: string;
  /** widget 短时 JWT；浏览器 WS 无法设 header，故走 query。生产应配合 HTTPS（query 进 access log）。 */
  token: string;
  /** 断线重连游标；null 表示首次连接。 */
  cursor: number | null;
}

/**
 * 自拼 widget WS URL。
 *
 * 不复用 protocol 包的 buildSessionSocketUrl——它产出 `?after_event_seq=`，而后端 ws.ts 实读 `?after_seq=`
 * （参数名不一致曾导致 durable outbox 增量回放哑火，已在 1c6693b 统一修复；此处沿用后端权威名 after_seq）。
 * 同时把 token 塞进 query。
 */
export function buildWidgetWsUrl(options: WidgetWsUrlOptions): string {
  const base = new URL(options.backendBase);
  const protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const path = `/api/agent/sessions/${encodeURIComponent(options.sessionId)}/ws`;
  const query = new URLSearchParams();
  if (options.cursor !== null) {
    query.set("after_seq", String(options.cursor));
  }
  query.set("token", options.token);
  return `${protocol}//${base.host}${path}?${query.toString()}`;
}

/** heartbeat 帧的 payload.last_seq / last_cursor（ws.ts 每 20s 回吐）取游标用。 */
export function extractCursor(envelope: Envelope): number | null {
  if (envelope.type === "heartbeat" && envelope.payload && typeof envelope.payload === "object") {
    const payload = envelope.payload as { last_seq?: unknown; last_cursor?: unknown };
    const candidate = payload.last_cursor ?? payload.last_seq;
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
  }
  return typeof envelope.seq === "number" && Number.isFinite(envelope.seq) ? envelope.seq : null;
}
