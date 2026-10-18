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
  | "createSession"
  | "listSessions"
  | "getSession"
  | "deleteSession"
  | "exportSession"
  | "listSessionsFacets"
  | "listSessionWorkspacePreview"
  | "listWorkspaces"
  | "createWorkspace"
  | "updateWorkspace"
  | "removeWorkspace"
  | "getSessionPermissions"
  | "updateSessionPermissions"
  | "getSessionRuntime"
  | "getSessionListStates"
  | "getContextSnapshot"
  | "rollbackAndRetrySession"
  | "listSessionParticipants"
  | "listSessionParticipantRuns"
  | "getParticipantRunSteps"
  | "listMessages"
  | "listMessageRequestStatuses"
  | "cancelQueuedMessageRequest"
  | "getMessageExecution"
  | "listMessageFeedback"
  | "setMessageFeedback"
  | "clearMessageFeedback"
  | "listFiles"
  | "uploadFiles"
  | "linkLocalFile"
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
  participantId?: string;
  runId?: string;
  workspaceId?: string;
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

export interface ListSessionsOptions {
  sessionIds?: readonly string[];
  limit?: number;
  cursor?: string | null;
  originType?: "direct" | "bot" | "widget" | null;
  originId?: string | null;
  workspaceId?: string | null;
  signal?: AbortSignal;
}

export interface ListSessionWorkspacePreviewOptions {
  limit?: number;
  originType?: "direct" | "bot" | "widget" | null;
  originId?: string | null;
  signal?: AbortSignal;
}

export interface ListMessagesOptions {
  limit?: number;
  offset?: number;
  participantId?: string;
  signal?: AbortSignal;
}

export interface UploadFilesOptions {
  fieldName?: string;
}

/** Local deployments only: register an existing file without copying its contents. */
export interface LinkLocalFileInput {
  path: string;
  original_name?: string;
  mime?: string;
}

export type { DelegatedToolSpec, InteractionResponse, PendingInteraction, ToolCallHandler, WebSocketFactory };
