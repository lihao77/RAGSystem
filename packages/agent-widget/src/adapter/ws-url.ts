import type { Envelope } from "@ragsystem/agent-protocol";

/**
 * widget WS 连接参数。ticket 每次建连前签发；cursor 来自最近收到的 envelope seq。
 */
export interface WidgetWsUrlOptions {
  /** 后端 origin（含协议），可带路径前缀，如 https://host.com/ragapi（走反代同源代理）。 */
  backendBase: string;
  sessionId: string;
  /** session-scoped、短时且单次使用的 WebSocket ticket。 */
  ticket: string;
  /** 断线重连游标；null 表示首次连接。 */
  cursor: number | null;
}

/**
 * 自拼 widget WS URL。
 *
 * 不复用 protocol 包的 buildSessionSocketUrl——它产出 `?after_event_seq=`，而后端 ws.ts 实读 `?after_seq=`
 * （参数名不一致曾导致 durable outbox 增量回放哑火，已在 1c6693b 统一修复；此处沿用后端权威名 after_seq）。
 * ticket 仅用于一次 WebSocket 握手；重连必须重新签发。
 */
export function buildWidgetWsUrl(options: WidgetWsUrlOptions): string {
  const base = new URL(options.backendBase);
  const protocol = base.protocol === "https:" ? "wss:" : "ws:";
  // backendBase 可带路径前缀（如反代 /ragapi），拼到 WS path 前以走同源代理。
  const basePath = base.pathname.replace(/\/+$/, "");
  const path = `${basePath}/api/agent/sessions/${encodeURIComponent(options.sessionId)}/ws`;
  const query = new URLSearchParams();
  if (options.cursor !== null) {
    query.set("after_seq", String(options.cursor));
  }
  query.set("ticket", options.ticket);
  const qs = query.toString();
  return `${protocol}//${base.host}${path}?${qs}`;
}

/** 顶层 seq 优先，heartbeat 帧回退 payload.last_seq（ws.ts 每 20s 回吐）。 */
export function extractCursor(envelope: Envelope): number | null {
  if (typeof envelope.seq === "number" && Number.isFinite(envelope.seq)) {
    return envelope.seq;
  }
  if (envelope.type === "heartbeat" && envelope.payload && typeof envelope.payload === "object") {
    const payload = envelope.payload as { last_seq?: unknown };
    return typeof payload.last_seq === "number" && Number.isFinite(payload.last_seq)
      ? payload.last_seq
      : null;
  }
  return null;
}
