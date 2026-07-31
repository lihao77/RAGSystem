import {
  SessionAgentClient,
  type SessionAgentClientOptions,
} from "@ragsystem/chat-sdk-core/session";
// The explicit session subpath keeps the widget's adapter dependency headless.
import type { DelegatedToolSpec } from "@ragsystem/agent-protocol";

export interface WidgetAgentClientOptions {
  /** 后端 origin，如 https://api.host.com。 */
  backendBase: string;
  sessionId: string;
  /** widget 短时 JWT，只用于 HTTP ticket 签发。 */
  token?: string;
  /** 浏览器嵌入使用的可公开 key；与 token 互斥。 */
  publishableKey?: string;
  hostTools?: DelegatedToolSpec[];
  fetch?: typeof fetch;
  createWebSocket?: SessionAgentClientOptions["createWebSocket"];
}

/**
 * Widget 兼容 adapter。
 *
 * 协议、重连、投影和上行逻辑全部来自 chat-sdk-core；这里仅保留 widget
 * 凭证对应的 ticket 端点，保证既有 Web Component API 不变。
 */
export class WidgetAgentClient extends SessionAgentClient {
  constructor(options: WidgetAgentClientOptions) {
    if (options.token && options.publishableKey) throw new Error("token 与 publishableKey 不能同时提供");
    super({
      baseUrl: options.backendBase,
      sessionId: options.sessionId,
      ...(options.hostTools ? { hostTools: options.hostTools } : {}),
      ...(options.createWebSocket ? { createWebSocket: options.createWebSocket } : {}),
      issueWsTicket: async (sessionId) => {
        const base = options.backendBase.replace(/\/$/, "");
        const isWidgetCredential = Boolean(options.token || options.publishableKey);
        const path = isWidgetCredential
          ? `/api/widget/sessions/${encodeURIComponent(sessionId)}/ws-ticket`
          : `/api/agent/sessions/${encodeURIComponent(sessionId)}/ws-ticket`;
        const headers: Record<string, string> = {};
        if (options.token) headers.authorization = `Bearer ${options.token}`;
        if (options.publishableKey) headers["x-widget-key"] = options.publishableKey;
        const fetchImpl = options.fetch ?? globalThis.fetch;
        if (typeof fetchImpl !== "function") throw new Error("当前环境不支持 fetch");
        const response = await fetchImpl(`${base}${path}`, { method: "POST", headers });
        if (!response.ok) throw new Error(`WebSocket ticket 签发失败: ${response.status}`);
        const body = await response.json() as { data?: { ticket?: unknown } };
        const ticket = body.data?.ticket;
        if (typeof ticket !== "string" || !ticket) throw new Error("WebSocket ticket 响应无效");
        return ticket;
      },
    });
  }
}

export type { WidgetAgentClientOptions as WidgetClientOptions };
