/**
 * @ragsystem/agent-widget —— 可嵌入任意第三方网页的 Agent 交互 widget 内核。
 *
 * 本包提供浏览器端 AgentClient adapter（连接 / 投影 / 上行 / 委托），框架无关；
 * UI 与 Web Component 打包在阶段 C 落地。消费者通过 WidgetAgentClient 接入：
 *
 *   const client = new WidgetAgentClient({ backendBase, sessionId, token, hostTools });
 *   await client.connect();
 *   client.executionTree.subscribe(tree => render(tree));
 *   await client.send({ task: "..." });
 */
export { WidgetAgentClient } from "./adapter/widget-agent-client.js";
export type { WidgetAgentClientOptions } from "./adapter/widget-agent-client.js";

export { WidgetWsTransport } from "./adapter/ws-transport.js";
export type { TransportHandlers, WidgetWsTransportOptions } from "./adapter/ws-transport.js";

export { ObservableValue } from "./adapter/observable.js";

export {
  buildWidgetWsUrl,
  extractCursor,
} from "./adapter/ws-url.js";
export type { WidgetWsUrlOptions } from "./adapter/ws-url.js";

export {
  encodeApprovalRespond,
  encodeDelegateResult,
  encodeSend,
  encodeStop,
  encodeToolsRegister,
  encodeUserInputRespond,
} from "./adapter/uplink-codec.js";
export type {
  ApprovalRespondUplink,
  DelegateResultUplink,
  SendUplink,
  StopUplink,
  ToolsRegisterUplink,
  UplinkMessage,
  UserInputRespondUplink,
} from "./adapter/uplink-codec.js";

// 重新导出协议层消费者常用类型，便于一处 import。
export type {
  AgentClient,
  ConnectionStatus,
  DelegatedToolDeclaration,
  DelegatedToolSpec,
  Envelope,
  ExecutionTree,
  InteractionResponse,
  Observable,
  PendingInteraction,
  ReconnectPolicy,
  RunStatus,
  SendOptions,
  SendResult,
  ToolCallHandler,
  ToolResult,
  Unsubscribe,
} from "@ragsystem/agent-protocol";
