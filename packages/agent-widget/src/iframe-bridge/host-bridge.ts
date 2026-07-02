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
import { DOM_TOOLS, inspectDoc } from "./dom-tools.js";
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
  /** 深度探测：经 frame-bridge __inspect__ action（触发其 inspect 或内置扫 DOM 元素清单）。 */
  callInspect: () => Promise<{ ok: boolean; observation: string; error?: string }>;
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
    callInspect: () => call("__inspect__", null),
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

/* ============================================================
 * 多 iframe 组合器：激活式工具切换
 * 用户（宿主 UI setActive）与 agent（switch_frame 工具）走同一切换入口；
 * 同一刻只把当前激活 iframe 的工具注册给 agent，避免 N 个 iframe 同名工具冲突。
 * ========================================================== */

/** 单个 iframe 的连接描述。 */
export interface FrameEntry {
  /** iframe 标识（list_frames/switch_frame 用；工具路由用）。 */
  id: string;
  frame: HTMLIFrameElement;
  /** iframe origin，必填，禁 "*"。 */
  targetOrigin: string;
  /** 展示名（list_frames 返回；缺省用 id）。 */
  label?: string;
}

/** widget 元素的最小注册接口（结构兼容 RagWidgetHandle，避免 bridge 反向依赖 widget 包）。 */
export interface HostToolRegistrar {
  registerHostTool: (spec: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    riskLevel?: "low" | "medium" | "high";
    execute: (input: unknown) => Promise<{ ok: boolean; observation: string; error?: string }>;
  }) => () => void;
  unregisterHostTool?: (name: string) => void;
}

export interface ConnectFramesOptions {
  /** widget 元素句柄（mount 返回值，结构兼容即可）。 */
  widgetEl: HostToolRegistrar;
  frames: FrameEntry[];
  /** 初始激活 frame id（默认 frames[0].id）。 */
  activeId?: string;
  /** 激活态变化回调（用户切换 + agent switch_frame 都触发，宿主 UI 据此同步高亮）。 */
  onActiveChange?: (id: string) => void;
  /** 主页面状态源（inspect：宿主自报详细状态，经 inspect_state 工具 source_id="host" 调用）。 */
  host?: { inspect?: () => string | Promise<string> };
}

export interface FrameInfo {
  id: string;
  label?: string;
  ready: boolean;
}

export interface FrameManager {
  /** 切换激活 frame（宿主 UI 用户切换 + agent switch_frame 共用同一入口）。 */
  setActive: (id: string) => void;
  /** 当前激活 frame id。 */
  getActive: () => string;
  /** 所有 frame 清单（供宿主 UI 渲染 tab）。 */
  listFrames: () => FrameInfo[];
  /** 注销：清所有 bridge + 已注册业务工具 + 管理工具。 */
  destroy: () => void;
}

export function connectFrames(options: ConnectFramesOptions): FrameManager {
  const { widgetEl, frames, onActiveChange, host } = options;
  if (!frames || frames.length === 0) throw new Error("frames 不能为空");

  interface FrameState {
    entry: FrameEntry;
    bridge: ConnectHandle;
    tools: DeclaredTool[];
    ready: boolean;
  }
  const stateMap = new Map<string, FrameState>();
  let activeId =
    options.activeId && frames.some((f) => f.id === options.activeId) ? options.activeId : frames[0]!.id;
  // 当前 active 注册的业务工具注销句柄（name → unsub）；切换时清空重注。
  const registered = new Map<string, () => void>();

  for (const entry of frames) {
    let st: FrameState | undefined;
    const bridge = connect({
      frame: entry.frame,
      targetOrigin: entry.targetOrigin,
      onTools: (tools) => {
        if (!st) return;
        st.tools = tools;
        st.ready = true;
        if (entry.id === activeId) applyActive();
      },
    });
    st = { entry, bridge, tools: [], ready: false };
    stateMap.set(entry.id, st);
  }

  // 常驻管理工具（不随 active 切换注销）。
  widgetEl.registerHostTool({
    name: "list_frames",
    description:
      "列出主页面嵌入的所有 iframe（系统）。返回每个 iframe 的 id、label、是否就绪、是否当前激活。操作某 iframe 前先调此工具拿 frame_id。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    riskLevel: "low",
    execute: async () => {
      const list = [...stateMap.values()].map((s) => ({
        id: s.entry.id,
        label: s.entry.label ?? s.entry.id,
        ready: s.ready,
        active: s.entry.id === activeId,
      }));
      return { ok: true, observation: JSON.stringify(list) };
    },
  });
  widgetEl.registerHostTool({
    name: "switch_frame",
    description:
      "切换当前激活的 iframe（工具集随之切换到目标 iframe）。切换后目标 iframe 的工具才可用。frame_id 来自 list_frames。",
    inputSchema: {
      type: "object",
      properties: { frame_id: { type: "string", description: "目标 iframe 的 id" } },
      required: ["frame_id"],
      additionalProperties: false,
    },
    riskLevel: "low",
    execute: async (input) => {
      const id = (input as { frame_id?: string }).frame_id;
      if (!id || !stateMap.has(id)) {
        return { ok: false, observation: `未知 frame_id: ${id ?? ""}`, error: `未知 frame_id: ${id ?? ""}` };
      }
      if (id !== activeId) setActive(id);
      const st = stateMap.get(id)!;
      const obs = st.ready
        ? `已切换到「${st.entry.label ?? id}」，${st.tools.length} 个工具可用：${st.tools.map((t) => t.name).join(", ")}`
        : `已切换到「${st.entry.label ?? id}」，工具尚未就绪`;
      return { ok: true, observation: obs };
    },
  });
  widgetEl.registerHostTool({
    name: "inspect_state",
    description:
      "深度探测某状态源的当前详细状态（页面可交互元素清单 + selector + 当前值）。source_id 缺省=当前激活 iframe；\"host\"=主页面。操作前调此工具看页面有什么可操作元素、selector 是什么。",
    inputSchema: {
      type: "object",
      properties: { source_id: { type: "string", description: "状态源 id（list_frames 中的 id，或 \"host\"；缺省=当前激活 iframe）" } },
      additionalProperties: false,
    },
    riskLevel: "low",
    execute: async (input) => {
      const sourceId = (input as { source_id?: string }).source_id;
      if (sourceId === "host") {
        try {
          const out = host?.inspect ? await host.inspect() : inspectDoc(document);
          return { ok: true, observation: String(out ?? "") };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return { ok: false, observation: error, error };
        }
      }
      const id = sourceId ?? activeId;
      const st = stateMap.get(id);
      if (!st) {
        return { ok: false, observation: `未知 source_id: ${id}`, error: `未知 source_id: ${id}` };
      }
      return st.bridge.callInspect();
    },
  });

  const clearActive = () => {
    for (const [, unsub] of registered) {
      try { unsub(); } catch {}
    }
    registered.clear();
  };
  const applyActive = () => {
    clearActive();
    const st = stateMap.get(activeId);
    if (!st || !st.ready) return;
    for (const t of st.tools) {
      const bridge = st.bridge;
      const unsub = widgetEl.registerHostTool({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.riskLevel ? { riskLevel: t.riskLevel } : {}),
        execute: (input) => bridge.call(t.name, input),
      });
      registered.set(t.name, unsub);
    }
  };
  const setActive = (id: string) => {
    if (!stateMap.has(id) || id === activeId) return;
    activeId = id;
    applyActive();
    onActiveChange?.(id);
  };

  return {
    setActive,
    getActive: () => activeId,
    listFrames: () => [...stateMap.values()].map((s) => ({ id: s.entry.id, label: s.entry.label ?? s.entry.id, ready: s.ready })),
    destroy: () => {
      clearActive();
      for (const [, s] of stateMap) s.bridge.destroy();
      widgetEl.unregisterHostTool?.("list_frames");
      widgetEl.unregisterHostTool?.("switch_frame");
      widgetEl.unregisterHostTool?.("inspect_state");
      stateMap.clear();
    },
  };
}

/**
 * 注册主页面（或同源 iframe）的 DOM 工具集给 agent——无 iframe 主场景开箱即用。
 *
 * - 注册 DOM_TOOLS（click/get_text/get_value/set_value/scroll_to/focus/submit，execute 绑定 doc）
 * - 注册 inspect_state（execute = inspectDoc(doc)，扫可交互元素清单）
 *
 * document 缺省=主页面 document；传同源 iframe 的 contentDocument 即控制该 iframe
 * （零侵入，不需 frame-bridge）。跨源 iframe 必须走 frame-bridge（同源策略）。
 *
 * 注意：与 connectFrames 的 inspect_state 同名，宿主按场景二选一（无 iframe 用本函数 / 多 iframe 用 connectFrames）。
 * 返回 unbind：注销全部。
 */
export function bindDomTools(options: { widgetEl: HostToolRegistrar; document?: Document }): () => void {
  const doc = options.document ?? (typeof document !== "undefined" ? document : null);
  if (!doc) throw new Error("bindDomTools: document 不可用（显式传 document 参数）");
  const unsubs: Array<() => void> = [];
  for (const t of DOM_TOOLS) {
    unsubs.push(
      options.widgetEl.registerHostTool({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.riskLevel ? { riskLevel: t.riskLevel } : {}),
        execute: async (input) => {
          try {
            const obs = await t.run(doc, input);
            return { ok: true, observation: String(obs ?? "") };
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return { ok: false, observation: error, error };
          }
        },
      }),
    );
  }
  unsubs.push(
    options.widgetEl.registerHostTool({
      name: "inspect_state",
      description: "深度探测当前页面的可交互元素清单（selector + 类型 + 当前值/标签）。操作前调此工具看页面有什么可操作元素、selector 是什么。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      riskLevel: "low",
      execute: async () => ({ ok: true, observation: inspectDoc(doc) }),
    }),
  );
  return () => {
    for (const u of unsubs) {
      try { u(); } catch {}
    }
  };
}
