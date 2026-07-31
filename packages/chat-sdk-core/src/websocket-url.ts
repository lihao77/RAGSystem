import type { Envelope } from "@ragsystem/agent-protocol/wire";
import { getEnvelopeCursorSeq } from "@ragsystem/agent-protocol/wire";

/**
 * Session WS 连接参数。ticket 每次建连前签发；cursor 来自最近收到的 envelope seq。
 */
export interface SessionWebSocketUrlOptions {
  /** 后端 origin（含协议），可带路径前缀，如 https://host.com/ragapi（走反代同源代理）。 */
  backendBase: string;
  sessionId: string;
  /** session-scoped、短时且单次使用的 WebSocket ticket。 */
  ticket: string;
  /** 断线重连游标；null 表示首次连接。 */
  cursor: number | null;
  /** HTTP 历史快照后首次接入时，要求后端补放 active run。 */
  historySnapshot?: boolean;
}

/**
 * 构造 Session WebSocket URL。
 *
 * URL 属于部署/API 约定而不是 wire protocol，由 headless transport 自己构造。
 * ticket 仅用于一次 WebSocket 握手；重连必须重新签发。
 */
export function buildSessionWebSocketUrl(options: SessionWebSocketUrlOptions): string {
  const origin = options.backendBase || globalThis.location?.origin;
  if (!origin) throw new Error("非浏览器环境必须配置 baseUrl");
  const base = new URL(origin);
  const protocol = base.protocol === "https:" ? "wss:" : "ws:";
  // backendBase 可带路径前缀（如反代 /ragapi），拼到 WS path 前以走同源代理。
  const basePath = base.pathname.replace(/\/+$/, "");
  const path = `${basePath}/api/agent/sessions/${encodeURIComponent(options.sessionId)}/ws`;
  const query = new URLSearchParams();
  if (options.cursor !== null) {
    query.set("after_seq", String(options.cursor));
  }
  if (options.historySnapshot) {
    query.set("history_snapshot", "1");
  }
  query.set("ticket", options.ticket);
  const qs = query.toString();
  return `${protocol}//${base.host}${path}?${qs}`;
}

/** 顶层 seq 优先，heartbeat 帧回退 payload.last_seq（ws.ts 每 20s 回吐）。 */
export function extractCursor(envelope: Envelope): number | null {
  return getEnvelopeCursorSeq(envelope);
}
