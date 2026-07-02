/**
 * iframe 跨源控制桥协议定义（frame-bridge ↔ host-bridge）。
 *
 * 主页面（widget 所在）经 host-bridge 用 postMessage 调用跨源 iframe（系统 B）里的 frame-bridge。
 * 工具声明整体归 iframe 自描述：frame-bridge serve 后发 ready 上报元数据清单，execute 留 iframe 本地。
 *
 * 消息前缀 ragframe_* 便于双方在共享 message 通道过滤自家协议；call_id 关联请求/响应（命名对齐委托链路）。
 */

/** 协议前缀；非 ragframe_* 的 message 一律忽略。 */
export const PROTOCOL_PREFIX = "ragframe";

/** host-bridge.call 默认超时（ms）。 */
export const DEFAULT_TIMEOUT_MS = 8000;

/** 主页面 → iframe：调用某个工具。 */
export interface RagFrameRequest {
  type: "ragframe_request";
  call_id: string;
  action: string;
  input: unknown;
}

/** iframe → 主页面：调用结果（observation 喂给 agent，语义对齐 delegate_result）。 */
export interface RagFrameResponse {
  type: "ragframe_response";
  call_id: string;
  ok: boolean;
  observation?: string;
  error?: string;
}

/** iframe → 主页面：事件/通知（ready=上报工具清单；hello=主页面请求重发 ready）。 */
export interface RagFrameEvent {
  type: "ragframe_event";
  event: string;
  payload?: unknown;
}

/** 工具元数据（ready 上报用；不含 execute）。 */
export interface DeclaredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel?: "low" | "medium" | "high";
}

/** ready 事件 payload：iframe 当前支持的工具元数据清单。 */
export interface ReadyPayload {
  tools: DeclaredTool[];
}

/** iframe 侧工具执行上下文（frame-bridge 注入）。 */
export interface FrameToolContext {
  callId: string;
}

/**
 * iframe 侧完整工具声明（含 execute；serve 注册用，execute 不上报）。
 * execute 返回 observation 字符串；抛错则框架捕获转 {ok:false,error}。
 */
export interface FrameTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel?: "low" | "medium" | "high";
  execute(input: unknown, ctx: FrameToolContext): string | Promise<string>;
}
