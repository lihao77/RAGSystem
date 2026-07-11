import type { Envelope } from "@ragsystem/agent-protocol";

/**
 * widget WS 连接参数。sessionId/token 由 mount 注入；cursor 来自最近收到的 envelope seq。
 */
export interface WidgetWsUrlOptions {
  /** 后端 origin（含协议），可带路径前缀，如 https://host.com/ragapi（走反代同源代理）。 */
  backendBase: string;
  sessionId: string;
  /**
   * widget 短时 JWT（可选）；浏览器 WS 无法设 header，故走 query。生产应配合 HTTPS（query 进 access log）。
   * 省略=内部普通会话：后端 ws.ts 仅对 widget 来源会话校验 token，普通会话零鉴权放行。
   */
  token?: string | undefined;
  /** 断线重连游标；null 表示首次连接。 */
  cursor: number | null;
}

/**
 * 自拼 widget WS URL。
 *
 * 不复用 protocol 包的 buildSessionSocketUrl——它产出 `?after_event_seq=`，而后端 ws.ts 实读 `?after_seq=`
 * （参数名不一致曾导致 durable outbox 增量回放哑火，已在 1c6693b 统一修复；此处沿用后端权威名 after_seq）。
 * 有 token 时塞进 query；普通会话（无 token）不带，后端不校验。
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
  if (options.token) {
    query.set("token", options.token);
  }
  const qs = query.toString();
  // cursor 与 token 均缺省时 query 为空，避免末尾悬垂 '?'。
  return qs ? `${protocol}//${base.host}${path}?${qs}` : `${protocol}//${base.host}${path}`;
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
