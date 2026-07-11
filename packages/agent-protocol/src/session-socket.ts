/**
 * WS 会话连接的协议/传输层工具（改写自前端 utils/sessionSocket.js）。
 *
 * 与原文件的差异：
 *   • seq（= session_seq）兼任去重与断线重连回放游标。
 *   • 仅保留协议/传输四函数；业务判断函数（shouldRefreshSessionMessagesAfterResume /
 *     shouldRunResumeRecoveryWatchdog）留在前端 composable，不进本包。
 *
 * 注意：buildSessionSocketUrl 产出的查询参数 after_seq 是后端 WS 路由
 * (routes/agent/ws.ts durable outbox 重放边界) 的参数名。
 */

const WS_OPEN = 1;
const WS_CONNECTING = 0;

/** 规整持久游标值；非正整数返回 null。 */
export function normalizeCursor(value: unknown): number | null {
  const seq = Number(value);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

/** 持久游标来源的宽松 envelope 视图。 */
interface CursorSource {
  seq?: unknown;
  type?: string;
  payload?: { last_seq?: unknown } | null;
}

/**
 * 从 envelope 提取持久 seq（断线重连回放边界）。
 * 优先顶层 seq，回退 heartbeat.payload.last_seq。
 */
export function getDurableSeq(env: CursorSource | null | undefined): number | null {
  if (!env || typeof env !== "object") return null;
  const top = normalizeCursor(env.seq);
  if (top !== null) return top;
  if (env.type !== "heartbeat") return null;
  return normalizeCursor(env.payload?.last_seq);
}

export interface BuildSessionSocketUrlOptions {
  protocol?: "http:" | "https:";
  host?: string;
  /** 持久 seq（= session_seq），断线重连回放边界。 */
  seq?: number;
}

/** 拼接会话 WS URL：ws(s)://host/api/agent/sessions/:id/ws[?after_seq=N]。 */
export function buildSessionSocketUrl(
  sessionId: string,
  options: BuildSessionSocketUrlOptions = {},
): string {
  const protocol = options.protocol === "https:" ? "wss:" : "ws:";
  const host = options.host ?? "";
  const encoded = encodeURIComponent(sessionId);
  const seq = normalizeCursor(options.seq);
  const query = seq === null ? "" : `?after_seq=${seq}`;
  return `${protocol}//${host}/api/agent/sessions/${encoded}/ws${query}`;
}

export interface ReusableSocketLike {
  readyState: number;
}

/** 判断目标会话的现有 WS 是否可复用（同会话且处于 open/connecting）。 */
export function canReuseSessionSocket(
  targetSessionId: string | null | undefined,
  currentSessionId: string | null | undefined,
  ws: ReusableSocketLike | null | undefined,
): boolean {
  if (!targetSessionId || !currentSessionId || targetSessionId !== currentSessionId || !ws) {
    return false;
  }
  return ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING;
}
