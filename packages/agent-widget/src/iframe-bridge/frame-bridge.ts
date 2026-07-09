/**
 * iframe 侧 SDK（系统 B 引入）。
 *
 * 声明完整工具（元数据 + execute），监听 postMessage，校验来源 origin，执行，回传结果。
 * serve 后向 parent 发 ready 事件，上报工具元数据清单（execute 不上报，留本地按 name 查）。
 *
 * 工具类型统一为 HostToolDeclaration（与主网页 host-tools 同源）——serve 声明的工具既可来自
 * ...RagFrameBridge.builtins（DOM 工具），也可自定义；execute 返回 ToolResult，bridge 回传 observation。
 * 不另造 FrameTool 接口：同一份工具定义，主网页直接注册 / 嵌入网页经 bridge 传递，两用。
 *
 * 握手：serve 即向首个白名单 origin 主动发 ready（兜底）；收到 parent 的 hello 则重发 ready。
 *       双向主动 + 幂等，覆盖 connect/serve 先后竞态。
 *
 * 安全：发送方 targetOrigin 用明确 origin（禁 "*"）；接收方校验 event.origin ∈ allowedParentOrigins；
 *       白名单外来源静默忽略（不回传，避免被探测）。
 */
import { PROTOCOL_PREFIX } from "./protocol.js";
import type {
  DeclaredTool,
  RagFrameEvent,
  RagFrameRequest,
  RagFrameResponse,
  ReadyPayload,
} from "./protocol.js";
import type { HostToolDeclaration } from "@ragsystem/agent-protocol";
import { BUILTIN_TOOLS } from "../host-tools/dom/builtins.js";
import { inspectDoc } from "../host-tools/dom/dom-tools.js";

const REQUEST_TYPE = `${PROTOCOL_PREFIX}_request`;
const RESPONSE_TYPE = `${PROTOCOL_PREFIX}_response`;
const EVENT_TYPE = `${PROTOCOL_PREFIX}_event`;

export interface ServeOptions {
  /** 允许的父窗口 origin 清单（其余来源静默忽略）。 */
  allowedParentOrigins: string[];
  /** 工具清单（同名时后声明覆盖；内置通过 ...RagFrameBridge.builtins 引入）。 */
  tools: HostToolDeclaration[];
  /**
   * 深度状态探测（主动）：host 调 inspect_state 工具时经 __inspect__ action 触发。
   * 缺省走 builtinInspect（扫 DOM 可交互元素清单）；系统 B 可覆盖返回业务详细状态。
   * 不进 tools 清单、不对 agent 直接可见（经 host 的 inspect_state 工具间接调用）。
   */
  inspect?: () => string | Promise<string>;
}

export interface ServeHandle {
  /** 注销：移除 message 监听。 */
  destroy: () => void;
  /** 手动重发 ready（工具集变更后调用，主页面侧需幂等处理重复注册）。 */
  republish: () => void;
}

function msgType(data: unknown): string | undefined {
  return typeof data === "object" && data !== null ? (data as { type?: string }).type : undefined;
}

export function serve(options: ServeOptions): ServeHandle {
  const tools = new Map<string, HostToolDeclaration>();
  for (const t of options.tools) tools.set(t.name, t);
  const allowed = new Set(options.allowedParentOrigins);
  const firstOrigin = options.allowedParentOrigins[0] ?? "";

  const toDeclared = (t: HostToolDeclaration): DeclaredTool => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.riskLevel ? { riskLevel: t.riskLevel } : {}),
  });

  const sendReady = (targetOrigin: string) => {
    if (window.parent === window) return; // 无父窗口（非 iframe）
    if (!targetOrigin) return;
    const payload: ReadyPayload = { tools: [...tools.values()].map(toDeclared) };
    const msg: RagFrameEvent = { type: EVENT_TYPE, event: "ready", payload };
    window.parent.postMessage(msg, targetOrigin);
  };

  // serve 即主动发 ready 兜底（parent 未监听则被浏览器丢弃，无副作用）。
  sendReady(firstOrigin);

  const handler = async (event: MessageEvent) => {
    if (!allowed.has(event.origin)) return; // 白名单外静默忽略
    if (event.source !== window.parent) return; // 只响应父窗口
    const data: unknown = event.data;

    // hello：parent 请求重发 ready（connect 晚于 serve 时主动 ready 已丢）。
    if (msgType(data) === EVENT_TYPE && (data as RagFrameEvent).event === "hello") {
      sendReady(event.origin);
      return;
    }

    if (msgType(data) !== REQUEST_TYPE) return;
    const { call_id, action, input } = data as RagFrameRequest;

    // 内部 action：__inspect__（深度状态探测，不在 tools 清单；经 host 的 inspect_state 工具间接调用）
    if (action === "__inspect__") {
      let resp: RagFrameResponse;
      try {
        const out = options.inspect ? await options.inspect() : inspectDoc(document);
        resp = { type: RESPONSE_TYPE, call_id, ok: true, observation: String(out ?? "") };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        resp = { type: RESPONSE_TYPE, call_id, ok: false, error };
      }
      (event.source as Window | null)?.postMessage(resp, event.origin);
      return;
    }

    const tool = tools.get(action);

    let resp: RagFrameResponse;
    if (!tool) {
      resp = { type: RESPONSE_TYPE, call_id, ok: false, error: `未注册的工具: ${action}` };
    } else {
      try {
        const result = await tool.execute(input);
        resp = {
          type: RESPONSE_TYPE,
          call_id,
          ok: result.ok,
          observation: result.observation ?? "",
          ...(result.error ? { error: result.error } : {}),
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        resp = { type: RESPONSE_TYPE, call_id, ok: false, error };
      }
    }
    // 回传：targetOrigin 用 event.origin（明确，禁 "*"）。
    const source = event.source as Window | null;
    source?.postMessage(resp, event.origin);
  };

  window.addEventListener("message", handler);

  return {
    destroy: () => window.removeEventListener("message", handler),
    republish: () => sendReady(firstOrigin),
  };
}

/** 内置 DOM 工具集（便于 `...RagFrameBridge.builtins` 引入）。 */
export const builtins: HostToolDeclaration[] = BUILTIN_TOOLS;
