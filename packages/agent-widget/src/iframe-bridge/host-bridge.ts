/**
 * 主页面侧 RPC 客户端（widget 所在宿主页引入）。
 *
 * 把 postMessage 包成 call(action,input)=>Promise<ToolResult> 的 RPC；收到 iframe 的 ready 事件
 * 回调 onTools（工具元数据清单），由宿主据此经 widget 透出的 registerHostTool 动态注册。
 *
 * 握手：connect 即发 hello（重试 6 次/500ms，收到 ready 即停），触发 iframe 重发 ready；
 *       覆盖 serve 先于 connect 时主动 ready 已丢的情况。iframe 也会主动发 ready 兜底。
 *
 * 安全：发送 targetOrigin 用配置的明确 origin（禁 "*"）；接收校验 event.origin === targetOrigin、
 *       event.source === frame.contentWindow。
 */
import { PROTOCOL_PREFIX, DEFAULT_TIMEOUT_MS } from "./protocol.js";
import type {
  DeclaredTool,
  RagFrameEvent,
  RagFrameRequest,
  RagFrameResponse,
  ReadyPayload,
} from "./protocol.js";

const REQUEST_TYPE = `${PROTOCOL_PREFIX}_request`;
const RESPONSE_TYPE = `${PROTOCOL_PREFIX}_response`;
const EVENT_TYPE = `${PROTOCOL_PREFIX}_event`;

export interface ConnectOptions {
  /** 目标 iframe 元素。 */
  frame: HTMLIFrameElement;
  /** iframe 的 origin，必填，禁 "*"（发送 targetOrigin + 接收 origin 校验都用它）。 */
  targetOrigin: string;
  /** call 超时（ms），默认 8000。 */
  timeout?: number;
  /** 收到 iframe ready（工具元数据清单）回调；每次到达都触发（含重发），宿主按 name 幂等注册。 */
  onTools?: (tools: DeclaredTool[]) => void;
  /** 其他 ragframe_event 回调（ready 之外）。 */
  onEvent?: (event: string, payload?: unknown) => void;
}

export interface ConnectHandle {
  /** RPC 调用：返回 ToolResult 形状（observation 必填，失败时为错误文本）。 */
  call: (action: string, input: unknown) => Promise<{ ok: boolean; observation: string; error?: string }>;
  /** 注销：移除监听、清 hello 定时器、决议所有 pending 为失败。 */
  destroy: () => void;
}

type ToolResultLike = { ok: boolean; observation: string; error?: string };

function msgType(data: unknown): string | undefined {
  return typeof data === "object" && data !== null ? (data as { type?: string }).type : undefined;
}

function newCallId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function connect(options: ConnectOptions): ConnectHandle {
  const { frame, targetOrigin, timeout = DEFAULT_TIMEOUT_MS, onTools, onEvent } = options;
  if (!targetOrigin || targetOrigin === "*") {
    throw new Error("targetOrigin 必填且不能为 \"*\"");
  }

  const pending = new Map<string, { resolve: (r: ToolResultLike) => void; timer: ReturnType<typeof setTimeout> }>();
  let readyReceived = false;
  let helloTries = 0;
  let destroyed = false;

  const sendHello = () => {
    frame.contentWindow?.postMessage({ type: EVENT_TYPE, event: "hello" }, targetOrigin);
  };

  const helloTimer = setInterval(() => {
    if (destroyed || readyReceived || helloTries >= 6) {
      clearInterval(helloTimer);
      return;
    }
    sendHello();
    helloTries++;
  }, 500);
  sendHello(); // 立即发一次，不等首个 500ms。

  const handler = (event: MessageEvent) => {
    if (event.origin !== targetOrigin) return; // 仅信任配置 origin
    if (event.source !== frame.contentWindow) return; // 仅响应目标 iframe
    const data: unknown = event.data;

    if (msgType(data) === RESPONSE_TYPE) {
      const resp = data as RagFrameResponse;
      const entry = pending.get(resp.call_id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(resp.call_id);
      if (resp.ok) {
        entry.resolve({ ok: true, observation: resp.observation ?? "" });
      } else {
        const error = resp.error ?? "调用失败";
        entry.resolve({ ok: false, observation: error, error });
      }
      return;
    }

    if (msgType(data) === EVENT_TYPE) {
      const evt = data as RagFrameEvent;
      if (evt.event === "ready") {
        readyReceived = true;
        const payload = (evt.payload ?? {}) as ReadyPayload;
        const tools = Array.isArray(payload.tools) ? payload.tools : [];
        onTools?.(tools);
      } else {
        onEvent?.(evt.event, evt.payload);
      }
    }
  };

  window.addEventListener("message", handler);

  const call = (action: string, input: unknown): Promise<ToolResultLike> => {
    return new Promise((resolve) => {
      if (destroyed) {
        resolve({ ok: false, observation: "bridge 已销毁", error: "bridge 已销毁" });
        return;
      }
      const call_id = newCallId();
      const req: RagFrameRequest = { type: REQUEST_TYPE, call_id, action, input };
      const timer = setTimeout(() => {
        if (!pending.delete(call_id)) return;
        resolve({ ok: false, observation: `超时（${timeout}ms）`, error: `超时（${timeout}ms）` });
      }, timeout);
      pending.set(call_id, { resolve, timer });
      frame.contentWindow?.postMessage(req, targetOrigin);
    });
  };

  return {
    call,
    destroy: () => {
      destroyed = true;
      clearInterval(helloTimer);
      window.removeEventListener("message", handler);
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.resolve({ ok: false, observation: "bridge 已销毁", error: "bridge 已销毁" });
      }
      pending.clear();
    },
  };
}
