import type {
  DelegatedToolSpec,
  InteractionResponse,
  PendingInteraction,
  ReconnectPolicy,
  ToolCallHandler,
} from "@ragsystem/agent-protocol";

import type { WebSocketFactory } from "./websocket-transport.js";

export type RagChatEndpointName =
  | "identity"
  | "logout"
  | "switchTenant"
  | "createSession"
  | "listSessions"
  | "getSession"
  | "deleteSession"
  | "listSessionsFacets"
  | "getSessionPermissions"
  | "updateSessionPermissions"
  | "listMessages"
  | "getMessageRunSteps"
  | "listFiles"
  | "uploadFiles"
  | "validateFiles"
  | "deleteFile"
  | "downloadFile"
  | "issueWsTicket"
  | "agui"
  | "aguiCancel";

export interface RagChatRequestContext {
  kind: RagChatEndpointName | "asset";
  url: string;
  sessionId?: string;
  fileId?: string;
  messageId?: string;
  body?: unknown;
}

export type RagChatEndpointResolver = string | ((context: Record<string, unknown>) => string);

export interface RagChatClientOptions {
  baseUrl?: string;
  token?: string;
  getToken?: (context: RagChatRequestContext) => string | undefined | Promise<string | undefined>;
  headers?: Record<string, string>;
  getHeaders?: (context: RagChatRequestContext) => Record<string, string> | Promise<Record<string, string>>;
  endpoints?: Partial<Record<RagChatEndpointName, RagChatEndpointResolver>>;
  fetch?: typeof fetch;
  createWebSocket?: WebSocketFactory;
  reconnect?: ReconnectPolicy;
  hostTools?: DelegatedToolSpec[];
  interactionHandlers?: Partial<Record<PendingInteraction["kind"], RagChatInteractionHandler>>;
  onInteractionRequest?: RagChatInteractionHandler;
  interactionTimeoutMs?: number;
  /** AG-UI SSE fallback used only while the session WebSocket is unavailable. */
  aguiFallback?: boolean | { endpoint?: RagChatEndpointResolver };
}

export type RagChatInteractionHandler = (
  request: PendingInteraction,
) => InteractionResponse | Promise<InteractionResponse>;

export interface RagChatLoginOptions {
  baseUrl?: string;
  username: string;
  password: string;
  endpoint?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export interface ListSessionsOptions {
  limit?: number;
  cursor?: string | null;
  originType?: "direct" | "bot" | "widget" | null;
  originId?: string | null;
  workspaceId?: string | null;
  signal?: AbortSignal;
}

export interface ListMessagesOptions {
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

export interface UploadFilesOptions {
  fieldName?: string;
}

export type { DelegatedToolSpec, InteractionResponse, PendingInteraction, ToolCallHandler, WebSocketFactory };
