export { RagChatClient, createRagChatClient } from "./client.js";
export { loginRagSystem } from "./auth.js";
export { RagChatError, RagChatHttpError } from "./errors.js";
export { SessionAgentClient } from "./session-client.js";
export { ChatWebSocketTransport } from "./websocket-transport.js";
export { buildSessionWebSocketUrl, extractCursor } from "./websocket-url.js";
export { ObservableValue, EventStream } from "./observable.js";
export { AguiSseClient } from "./agui.js";

export type {
  RagChatClientOptions,
  RagChatLoginOptions,
  RagChatEndpointName,
  RagChatEndpointResolver,
  RagChatInteractionHandler,
  RagChatRequestContext,
  ListSessionsOptions,
  ListMessagesOptions,
  UploadFilesOptions,
} from "./types.js";
export type {
  AguiEvent,
  AguiMessageInput,
  AguiResumeInput,
  AguiRunHandle,
  AguiRunInput,
  AguiSseClientOptions,
} from "./agui.js";
export type { SessionAgentClientOptions } from "./session-client.js";
export type {
  ChatWebSocketTransportOptions,
  TransportHandlers,
  WebSocketFactory,
} from "./websocket-transport.js";
export type { SessionWebSocketUrlOptions } from "./websocket-url.js";

// 协议类型是 headless SDK 的核心公共契约，避免消费者再安装第二个类型入口。
export type {
  AgentClient,
  ConnectionStatus,
  ConnectOptions,
  DelegatedToolSpec,
  Envelope,
  ExecutionTree,
  InteractionResponse,
  Observable,
  PendingInteraction,
  ReconnectPolicy,
  RunStatus,
  SessionRuntimePayload,
  SendOptions,
  SendResult,
  ToolCallHandler,
  ToolResult,
  Unsubscribe,
} from "@ragsystem/agent-protocol";

export type {
  AuthIdentity,
  AuthSession,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionDetailResponse,
  SessionListFacetsResponse,
  SessionListResponse,
  SessionMessageListResponse,
  SessionMessageRunStepsResponse,
  SessionPermissionResponse,
  UpdateSessionPermissionModeRequest,
} from "@ragsystem/api-contracts";
