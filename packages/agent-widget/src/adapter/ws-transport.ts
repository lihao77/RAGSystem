import type { Envelope } from "@ragsystem/agent-protocol/wire";
import { ServerToClientEnvelopeSchema } from "@ragsystem/agent-protocol/wire";
import type { ConnectionStatus, ReconnectPolicy } from "@ragsystem/agent-protocol/client";

/** 收到合法下行 Envelope（已 zod 校验）+ 连接状态变化时回调 client。 */
export interface TransportHandlers {
  onEnvelope(env: Envelope): void;
  onStatus(status: ConnectionStatus): void;
}

export interface WidgetWsTransportOptions {
  /** 每次连接前异步签发 ticket，并返回带最新 cursor 的 URL。 */
  resolveUrl: () => Promise<string>;
  /** 会话 id（status=connected 回填用）。 */
  sessionId: string;
  handlers: TransportHandlers;
  reconnect?: ReconnectPolicy;
}

/** 后端心跳间隔 20s（ws.ts），客户端 60s 无任何帧判连接僵死、主动断开重连。 */
const HEARTBEAT_TIMEOUT_MS = 60_000;
const DEFAULT_RECONNECT: Required<ReconnectPolicy> = {
  enabled: true,
  maxRetries: 10,
  baseDelayMs: 1000,
  maxDelayMs: 15_000,
};

/**
 * widget WS 传输层：连接 + 心跳 + 指数退避重连。
 *
 * 职责单一——只管字节收发与连接状态机，不管协议语义：
 * - 下行帧用 ServerToClientEnvelopeSchema 校验后透传给 client（投影 / 控制帧分流由 client 决定）。
 * - 重连用 resolveReconnectUrl() 拿最新 cursor，保证 durable outbox 增量回放边界正确。
 * - tools.register 等握手协议在 client 层（status=connected 时发），不在本层。
 */
export class WidgetWsTransport {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private lastSeq: number | null = null;
  private readonly policy: Required<ReconnectPolicy>;

  constructor(private readonly options: WidgetWsTransportOptions) {
    this.policy = { ...DEFAULT_RECONNECT, ...mergeReconnect(options.reconnect) };
  }

  connect(): void {
    this.disposed = false;
    void this.openResolved(true);
  }

  /** 手动重连：重置退避计数后发起新连接（自动重连耗尽进 disconnected 后，UI 可调此恢复）。 */
  reconnect(): void {
    this.clearTimers();
    if (this.ws) {
      // 清掉旧 ws 监听，避免其 onclose 再触发一次 scheduleReconnect 造成双连。
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        // 忽略重复关闭
      }
      this.ws = null;
    }
    this.reconnectAttempts = 0;
    void this.openResolved(false);
  }

  send(message: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  disconnect(): void {
    this.disposed = true;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close(1000, "client disconnect");
      } catch {
        // 忽略重复关闭
      }
      this.ws = null;
    }
    this.emitStatus({ state: "disconnected" });
  }

  private async openResolved(isFirst: boolean): Promise<void> {
    this.emitStatus(
      isFirst
        ? { state: "connecting" }
        : { state: "reconnecting", replayCount: this.reconnectAttempts },
    );
    try {
      const url = await this.options.resolveUrl();
      if (this.disposed) return;
      this.open(url);
    } catch {
      if (!this.disposed) this.scheduleReconnect();
    }
  }

  private open(url: string): void {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.resetHeartbeat();
      this.emitStatus({
        state: "connected",
        sessionId: this.options.sessionId,
        lastEventSeq: this.lastSeq,
      });
    };
    ws.onmessage = (event: MessageEvent) => {
      this.resetHeartbeat();
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      let env: Envelope;
      try {
        env = ServerToClientEnvelopeSchema.parse(JSON.parse(raw)) as Envelope;
      } catch {
        return; // 非 envelope / 校验失败：静默丢弃，不影响连接
      }
      if (typeof env.seq === "number") {
        this.lastSeq = env.seq;
      }
      this.options.handlers.onEnvelope(env);
    };
    ws.onclose = () => {
      this.clearTimers();
      if (this.disposed) {
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onerror 后通常紧跟 onclose，重连在 onclose 统一触发，此处不重复处理。
    };
  }

  private scheduleReconnect(): void {
    if (!this.policy.enabled) {
      this.emitStatus({ state: "disconnected", reason: "connection closed" });
      return;
    }
    if (this.reconnectAttempts >= this.policy.maxRetries) {
      this.emitStatus({ state: "disconnected", reason: "max retries exceeded" });
      return;
    }
    const delay = Math.min(
      this.policy.baseDelayMs * 2 ** this.reconnectAttempts,
      this.policy.maxDelayMs,
    );
    this.reconnectAttempts += 1;
    this.emitStatus({ state: "reconnecting", replayCount: this.reconnectAttempts });
    this.reconnectTimer = setTimeout(() => {
      if (this.disposed) {
        return;
      }
      void this.openResolved(false);
    }, delay);
  }

  private resetHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }
    this.heartbeatTimer = setTimeout(() => {
      // 60s 无任何帧 → 判僵死，主动断开触发重连。
      try {
        this.ws?.close(4000, "heartbeat timeout");
      } catch {
        // 忽略
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private emitStatus(status: ConnectionStatus): void {
    this.options.handlers.onStatus(status);
  }
}

/** 合并用户 reconnect 覆盖项，剔除 undefined（exactOptionalPropertyTypes 友好）。 */
function mergeReconnect(policy: ReconnectPolicy | undefined): Partial<Required<ReconnectPolicy>> {
  if (!policy) {
    return {};
  }
  const out: Partial<Required<ReconnectPolicy>> = {};
  out.enabled = policy.enabled;
  if (policy.maxRetries !== undefined) {
    out.maxRetries = policy.maxRetries;
  }
  if (policy.baseDelayMs !== undefined) {
    out.baseDelayMs = policy.baseDelayMs;
  }
  if (policy.maxDelayMs !== undefined) {
    out.maxDelayMs = policy.maxDelayMs;
  }
  return out;
}
