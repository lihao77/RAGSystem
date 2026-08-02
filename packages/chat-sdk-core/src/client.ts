import type {
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
import type {
  AgentClient,
  ConnectionStatus,
  ExecutionTree,
  InteractionResponse,
  Observable,
  PendingInteraction,
  RunStatus,
  SessionRuntimePayload,
  SendOptions,
  SendResult,
  ToolCallHandler,
  Unsubscribe,
} from "@ragsystem/agent-protocol";

import { EventStream, ObservableValue } from "./observable.js";
import { SessionAgentClient, type SessionConnectOptions } from "./session-client.js";
import { RagChatError, RagChatHttpError } from "./errors.js";
import { RagChatEventEmitter } from "./event-emitter.js";
import { bindFetch, mergeHeaders } from "./fetch-utils.js";
import { AguiSseClient, type AguiEvent, type AguiRunHandle, type AguiRunInput } from "./agui.js";
import type {
  ListMessagesOptions,
  ListSessionsOptions,
  RagChatClientOptions,
  RagChatEndpointName,
  RagChatInteractionHandler,
  RagChatRequestContext,
  UploadFilesOptions,
} from "./types.js";

const EMPTY_RUNTIME: SessionRuntimePayload = {
  state: "idle",
  load_strategy: "history",
  allowed_actions: [],
  active_run: null,
  last_run: null,
  pending_interactions: [],
  resume_interaction_id: null,
  maintenance: null,
  observed_at: "",
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
  query?: URLSearchParams;
  context?: Record<string, unknown>;
};

/**
 * RAGSystem 的无 UI 客户端门面。
 *
 * REST 负责认证后的资源管理，SessionAgentClient 负责长期 WebSocket、事件投影、
 * 重连和上行控制。调用方只依赖这一层，不需要拼接两套客户端。
 */
export class RagChatClient {
  private readonly baseUrl: string;
  private readonly options: RagChatClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly eventEmitter = new RagChatEventEmitter();
  private readonly fallbackStatus = new ObservableValue<ConnectionStatus>({ state: "idle" });
  private readonly fallbackEvents = new EventStream();
  private readonly fallbackTree = new ObservableValue<ExecutionTree>({ root: null, steps: [] });
  private readonly fallbackRuntime = new ObservableValue<SessionRuntimePayload>(EMPTY_RUNTIME);
  private readonly fallbackRunStatus = new ObservableValue<RunStatus>({ runId: null, state: "idle" });
  private readonly fallbackPending = new ObservableValue<PendingInteraction[]>([]);
  private sessionClient: SessionAgentClient | null = null;
  private sessionIdValue: string | null = null;
  private sessionUnsubscribers: Unsubscribe[] = [];
  private readonly hostTools = new Map<string, Parameters<AgentClient["registerTool"]>[0]>();
  private readonly toolCallHandlers = new Set<ToolCallHandler>();
  private delegationEnabled = false;
  private readonly interactionHandlers = new Map<string, RagChatInteractionHandler>();
  private readonly interactionRequests = new Set<string>();
  private readonly interactionTimeoutMs: number;
  private readonly fallbackInteractionHandler: RagChatInteractionHandler | undefined;
  private destroyed = false;

  constructor(options: RagChatClientOptions = {}) {
    this.options = options;
    this.baseUrl = trimBaseUrl(options.baseUrl);
    const fetchImpl = bindFetch(options.fetch ?? globalThis.fetch);
    if (!fetchImpl) {
      throw new RagChatError("当前环境不支持 fetch", { code: "FETCH_UNAVAILABLE" });
    }
    this.fetchImpl = fetchImpl;
    for (const spec of options.hostTools ?? []) this.hostTools.set(spec.name, spec);
    this.delegationEnabled = this.hostTools.size > 0;
    for (const [kind, handler] of Object.entries(options.interactionHandlers ?? {})) {
      if (handler) this.interactionHandlers.set(kind, handler);
    }
    this.fallbackInteractionHandler = options.onInteractionRequest;
    this.interactionTimeoutMs = clampInteractionTimeout(options.interactionTimeoutMs);
  }

  on(type: string, listener: (payload: unknown) => void): Unsubscribe {
    return this.eventEmitter.on(type, listener);
  }

  off(type: string, listener: (payload: unknown) => void): void {
    this.eventEmitter.off(type, listener);
  }

  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  get isConnected(): boolean {
    return this.sessionClient?.status.get().state === "connected";
  }

  get isRunning(): boolean {
    const state = this.sessionClient?.runStatus.get().state;
    return state === "running" || state === "waiting_interaction" || state === "resuming";
  }

  get status(): Observable<ConnectionStatus> {
    return this.fallbackStatus;
  }

  get eventsStream(): Observable<import("@ragsystem/agent-protocol").Envelope> {
    return this.fallbackEvents;
  }

  get events(): Observable<import("@ragsystem/agent-protocol").Envelope> {
    return this.eventsStream;
  }

  get executionTree(): Observable<ExecutionTree> {
    return this.fallbackTree;
  }

  get runtime(): Observable<SessionRuntimePayload> {
    return this.fallbackRuntime;
  }

  get runStatus(): Observable<RunStatus> {
    return this.fallbackRunStatus;
  }

  get pendingInteractions(): Observable<PendingInteraction[]> {
    return this.fallbackPending;
  }

  get pendingInteractionIds(): string[] {
    return this.sessionClient?.pendingInteractions.get().map((item) => item.interactionId) ?? [];
  }

  async getIdentity(): Promise<AuthIdentity> {
    return this.request<AuthIdentity>("identity");
  }

  async logout(): Promise<unknown> {
    return this.request("logout", { method: "POST" });
  }

  async switchTenant(tenantId: string): Promise<AuthSession> {
    return this.request<AuthSession>("switchTenant", { method: "POST", body: { tenantId } });
  }

  async createSession(body: CreateSessionRequest = {}): Promise<CreateSessionResponse> {
    return this.request<CreateSessionResponse>("createSession", { method: "POST", body });
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SessionListResponse> {
    const query = new URLSearchParams();
    query.set("limit", String(options.limit ?? 20));
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.originType) query.set("origin_type", options.originType);
    if (options.originId) query.set("origin_id", options.originId);
    if (options.workspaceId) query.set("workspace_id", options.workspaceId);
    return this.request<SessionListResponse>("listSessions", { query, ...(options.signal ? { signal: options.signal } : {}) });
  }

  async getSession(sessionId: string): Promise<SessionDetailResponse> {
    return this.request<SessionDetailResponse>("getSession", { context: { sessionId } });
  }

  async deleteSession(sessionId: string): Promise<unknown> {
    return this.request("deleteSession", { method: "DELETE", context: { sessionId } });
  }

  async exportSession(sessionId: string, init: RequestInit = {}): Promise<Response> {
    this.assertAlive();
    const url = this.resolveEndpoint("exportSession", { sessionId });
    const context: RagChatRequestContext = { kind: "exportSession", url, sessionId };
    const headers = await this.resolveHeaders(context);
    const response = await this.fetchImpl(url, {
      ...init,
      method: "GET",
      headers: mergeHeaders(headers, init.headers),
    });
    if (!response.ok) {
      if (response.status === 401) this.emit("unauthorized", { status: 401 });
      const details = await readResponseBody(response);
      throw new RagChatHttpError(response.status, getErrorMessage(details, `会话导出失败 (HTTP ${response.status})`), details);
    }
    return response;
  }

  async getSessionFacets(options: { signal?: AbortSignal } = {}): Promise<SessionListFacetsResponse> {
    return this.request<SessionListFacetsResponse>("listSessionsFacets", {
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async getSessionPermissions(sessionId: string): Promise<SessionPermissionResponse> {
    return this.request<SessionPermissionResponse>("getSessionPermissions", { context: { sessionId } });
  }

  async updateSessionPermissions(sessionId: string, mode: UpdateSessionPermissionModeRequest["mode"]): Promise<SessionPermissionResponse> {
    return this.request<SessionPermissionResponse>("updateSessionPermissions", {
      method: "PATCH",
      body: { mode },
      context: { sessionId },
    });
  }

  async getSessionRuntime(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    return this.request("getSessionRuntime", {
      context: { sessionId },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async getContextSnapshot(sessionId: string, options: { selectedLlm?: string; signal?: AbortSignal } = {}): Promise<unknown> {
    const query = new URLSearchParams();
    if (sessionId) query.set("session_id", sessionId);
    if (options.selectedLlm) query.set("selected_llm", options.selectedLlm);
    return this.request("getContextSnapshot", {
      query,
      context: { sessionId },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async rollbackAndRetrySession(sessionId: string, body: unknown): Promise<unknown> {
    return this.request("rollbackAndRetrySession", {
      method: "POST",
      body,
      context: { sessionId },
    });
  }

  async listMessages(sessionId: string, options: ListMessagesOptions = {}): Promise<SessionMessageListResponse> {
    const query = new URLSearchParams({
      limit: String(options.limit ?? 500),
      offset: String(options.offset ?? 0),
    });
    return this.request<SessionMessageListResponse>("listMessages", { context: { sessionId }, query, ...(options.signal ? { signal: options.signal } : {}) });
  }

  async getMessageRunSteps(sessionId: string, messageId: string, options: ListMessagesOptions = {}): Promise<SessionMessageRunStepsResponse> {
    const query = new URLSearchParams({
      limit: String(options.limit ?? 500),
      offset: String(options.offset ?? 0),
    });
    return this.request<SessionMessageRunStepsResponse>("getMessageRunSteps", {
      context: { sessionId, messageId }, query, ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async listFiles(sessionId: string): Promise<unknown> {
    return this.request("listFiles", { context: { sessionId } });
  }

  async uploadFiles(sessionId: string, files: File[] | FileList, options: UploadFilesOptions = {}): Promise<unknown> {
    const formData = new FormData();
    for (const file of Array.from(files)) formData.append(options.fieldName ?? "files", file);
    return this.request("uploadFiles", { method: "POST", context: { sessionId }, formData });
  }

  async validateFiles(sessionId: string, fileIds: string[]): Promise<unknown> {
    return this.request("validateFiles", { method: "POST", context: { sessionId }, body: { file_ids: fileIds } });
  }

  async deleteFile(sessionId: string, fileId: string): Promise<unknown> {
    return this.request("deleteFile", { method: "DELETE", context: { sessionId, fileId } });
  }

  startAguiRun(input: AguiRunInput, options: { signal?: AbortSignal; onEvent?: (event: AguiEvent) => void } = {}): AguiRunHandle {
    this.assertAlive();
    if (!input.threadId) throw new RagChatError("AG-UI threadId 不能为空", { code: "AGUI_THREAD_ID_REQUIRED" });
    const configured = this.options.aguiFallback;
    const endpointOverride = configured && typeof configured === "object" ? configured.endpoint : undefined;
    const url = this.resolveEndpoint("agui", { threadId: input.threadId, body: input }, undefined, endpointOverride);
    const context: RagChatRequestContext = { kind: "agui", url, sessionId: input.threadId, body: input };
    const trustedEndpoint = isTrustedUrl(url, this.baseUrl);
    const client = new AguiSseClient({
      endpoint: url,
      fetch: this.fetchImpl,
      resolveHeaders: () => this.resolveHeaders(context, trustedEndpoint),
      ...(options.onEvent ? { onEvent: (event) => {
        this.emit("agui_event", event);
        options.onEvent?.(event);
      } } : { onEvent: (event) => this.emit("agui_event", event) }),
    });
    const run = client.start(input, options.signal);
    let unauthorizedEmitted = false;
    const handleFailure = (error: unknown) => {
      if (trustedEndpoint && !unauthorizedEmitted && error instanceof RagChatHttpError && error.status === 401) {
        unauthorizedEmitted = true;
        this.emit("unauthorized", { status: 401 });
      }
    };
    void run.started.catch(handleFailure);
    void run.completed.catch(handleFailure);
    return run;
  }

  async downloadFile(sessionId: string, fileId: string, init: RequestInit = {}): Promise<Response> {
    this.assertAlive();
    const requestContext = { sessionId, fileId };
    const url = this.resolveEndpoint("downloadFile", requestContext);
    const context: RagChatRequestContext = { kind: "downloadFile", url, sessionId, fileId };
    const headers = await this.resolveHeaders(context);
    const response = await this.fetchImpl(url, {
      ...init,
      method: "GET",
      headers: mergeHeaders(headers, init.headers),
    });
    if (!response.ok) {
      if (response.status === 401) this.emit("unauthorized", { status: 401 });
      const details = await readResponseBody(response);
      throw new RagChatHttpError(response.status, getErrorMessage(details, `文件下载失败 (HTTP ${response.status})`), details);
    }
    return response;
  }

  async fetchAsset(url: string, init: RequestInit = {}): Promise<Response> {
    if (!url) throw new RagChatError("资源地址不能为空", { code: "ASSET_URL_REQUIRED" });
    this.assertAlive();
    const context: RagChatRequestContext = { kind: "asset", url };
    const trustedUrl = isTrustedUrl(url, this.baseUrl);
    const headers = await this.resolveHeaders(context, trustedUrl);
    const response = await this.fetchImpl(url, { ...init, headers: mergeHeaders(headers, init.headers) });
    if (!response.ok) {
      if (trustedUrl && response.status === 401) this.emit("unauthorized", { status: 401 });
      throw new RagChatHttpError(response.status, `资源请求失败 (HTTP ${response.status})`);
    }
    return response;
  }

  connect(sessionId: string, options: SessionConnectOptions = {}): Promise<void> {
    const pending = this.connectInternal(sessionId, options);
    void pending.catch(() => undefined);
    return pending;
  }

  private async connectInternal(sessionId: string, options: SessionConnectOptions = {}): Promise<void> {
    this.assertAlive();
    if (!sessionId) throw new RagChatError("sessionId 不能为空", { code: "SESSION_ID_REQUIRED" });
    if (this.sessionIdValue === sessionId && this.sessionClient) {
      await this.sessionClient.connect(options);
      return;
    }
    if (this.sessionClient) this.disconnect();
    const session = new SessionAgentClient({
      baseUrl: this.baseUrl,
      sessionId,
      issueWsTicket: (id) => this.issueWsTicket(id),
      ...(this.options.reconnect ? { reconnect: this.options.reconnect } : {}),
      ...(this.options.createWebSocket ? { createWebSocket: this.options.createWebSocket } : {}),
      hostTools: [...this.hostTools.values()],
      ...(this.options.aguiFallback !== false ? {
        aguiFallback: (input: AguiRunInput, onEvent: (event: AguiEvent) => void) => this.startAguiRun(input, { onEvent }),
        cancelAguiRun: (id: string, runId?: string) => this.cancelAguiRun(id, runId),
      } : {}),
    });
    if (this.delegationEnabled) session.enableDelegation();
    this.sessionClient = session;
    this.sessionIdValue = sessionId;
    for (const handler of this.toolCallHandlers) session.onToolCall(handler);
    this.bindSession(session);
    await session.connect(options);
  }

  disconnect(): void {
    const session = this.sessionClient;
    if (session) {
      // 保持订阅直到 transport 发布 disconnected，使门面事件与 fallback 快照都能收到终态。
      session.disconnect();
    } else {
      const status: ConnectionStatus = { state: "disconnected" };
      this.fallbackStatus.set(status);
      this.emit("status", status);
    }
    for (const unsubscribe of this.sessionUnsubscribers.splice(0)) unsubscribe();
    this.sessionClient = null;
    this.sessionIdValue = null;
    this.interactionRequests.clear();
    this.fallbackTree.set({ root: null, steps: [] });
    this.fallbackRuntime.set(EMPTY_RUNTIME);
    this.fallbackRunStatus.set({ runId: null, state: "idle" });
    this.fallbackPending.set([]);
  }

  async send(options: SendOptions): Promise<SendResult> {
    return this.requireSession().send(options);
  }

  stop(): void {
    this.sessionClient?.stop();
  }

  async respondInteraction(interactionId: string, response: InteractionResponse): Promise<void> {
    return this.requireSession().respondInteraction(interactionId, response);
  }

  approve(interactionId: string, approved: boolean, message?: string): Promise<void> {
    return this.requireSession().approve(interactionId, approved, message);
  }

  respondInput(interactionId: string, value: string): Promise<void> {
    return this.requireSession().respondInput(interactionId, value);
  }

  resume(): Promise<boolean> {
    return this.requireSession().resume();
  }

  enableDelegation(): void {
    this.delegationEnabled = true;
    this.sessionClient?.enableDelegation();
  }

  registerTool(spec: Parameters<AgentClient["registerTool"]>[0]): Unsubscribe {
    this.hostTools.set(spec.name, spec);
    this.delegationEnabled = true;
    const unregister = this.sessionClient?.registerTool(spec);
    return () => {
      if (this.hostTools.get(spec.name) !== spec) return;
      this.hostTools.delete(spec.name);
      this.sessionClient?.unregisterTool(spec);
      unregister?.();
    };
  }

  onToolCall(handler: ToolCallHandler): Unsubscribe {
    this.toolCallHandlers.add(handler);
    const unregister = this.sessionClient?.onToolCall(handler);
    return () => {
      this.toolCallHandlers.delete(handler);
      this.sessionClient?.removeToolCallHandler(handler);
      unregister?.();
    };
  }

  registerInteractionHandler(kind: string, handler: RagChatInteractionHandler): Unsubscribe {
    if (!kind || typeof handler !== "function") throw new TypeError("交互类型和 handler 不能为空");
    this.interactionHandlers.set(kind, handler);
    return () => {
      if (this.interactionHandlers.get(kind) === handler) this.interactionHandlers.delete(kind);
    };
  }

  cancelToolCall(callId: string, reason?: string): void {
    this.sessionClient?.cancelToolCall(callId, reason);
  }

  sendRaw(message: Record<string, unknown>): void {
    this.requireSession().sendRaw(message);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disconnect();
    this.eventEmitter.clear();
  }

  private bindSession(session: SessionAgentClient): void {
    this.sessionUnsubscribers.push(
      session.status.subscribe((value) => {
        this.fallbackStatus.set(value);
        this.emit("status", value);
      }),
      session.events.subscribe((value) => {
        this.fallbackEvents.emit(value);
        this.emit("event", value);
        this.emit(value.type, value);
      }),
      session.executionTree.subscribe((value) => {
        this.fallbackTree.set(value);
        this.emit("execution_tree", value);
      }),
      session.runtime.subscribe((value) => {
        this.fallbackRuntime.set(value);
        this.emit("runtime", value);
      }),
      session.runStatus.subscribe((value) => {
        this.fallbackRunStatus.set(value);
        this.emit("run_status", value);
      }),
      session.pendingInteractions.subscribe((value) => {
        this.fallbackPending.set(value);
        this.emit("pending_interactions", value);
        this.handleInteractionRequests(value);
      }),
    );
  }

  private handleInteractionRequests(requests: PendingInteraction[]): void {
    const current = new Set(requests.map((request) => request.interactionId));
    for (const id of this.interactionRequests) {
      if (!current.has(id)) this.interactionRequests.delete(id);
    }
    for (const request of requests) {
      if (this.interactionRequests.has(request.interactionId)) continue;
      this.interactionRequests.add(request.interactionId);
      this.emit("interaction_request", request);
      const handler = this.interactionHandlers.get(request.kind) ?? this.fallbackInteractionHandler;
      if (handler) void this.runInteractionHandler(request, handler, this.sessionClient);
    }
  }

  private async runInteractionHandler(
    request: PendingInteraction,
    handler: RagChatInteractionHandler,
    sessionAtDispatch: SessionAgentClient | null,
  ): Promise<void> {
    try {
      const response = await withTimeout(
        Promise.resolve().then(() => handler(request)),
        this.interactionTimeoutMs,
      );
      // A handler can outlive a route/session switch. Never submit its answer
      // to the newly active session.
      if (this.sessionClient !== sessionAtDispatch) return;
      await this.respondInteraction(request.interactionId, response);
    } catch (error) {
      this.emit("error", error);
    }
  }

  private emit(type: string, payload: unknown): void {
    this.eventEmitter.emit(type, payload);
  }

  private async issueWsTicket(sessionId: string): Promise<string> {
    const response = await this.request<{ data?: { ticket?: unknown } }>("issueWsTicket", {
      method: "POST",
      context: { sessionId },
    });
    const ticket = response.data?.ticket;
    if (typeof ticket !== "string" || !ticket) throw new RagChatError("WebSocket ticket 响应无效", { code: "INVALID_WS_TICKET" });
    return ticket;
  }

  private requireSession(): SessionAgentClient {
    this.assertAlive();
    if (!this.sessionClient) throw new RagChatError("尚未连接 Session", { code: "SESSION_NOT_CONNECTED" });
    return this.sessionClient;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new RagChatError("客户端已销毁", { code: "CLIENT_DESTROYED" });
  }

  private async request<T>(name: RagChatEndpointName, options: RequestOptions = {}): Promise<T> {
    this.assertAlive();
    const context: RagChatRequestContext = {
      kind: name,
      url: "",
      ...(typeof options.context?.sessionId === "string" ? { sessionId: options.context.sessionId } : {}),
      ...(typeof options.context?.fileId === "string" ? { fileId: options.context.fileId } : {}),
      ...(typeof options.context?.messageId === "string" ? { messageId: options.context.messageId } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
    };
    const url = this.resolveEndpoint(name, options.context ?? {}, options.query);
    context.url = url;
    const headers = await this.resolveHeaders(context);
    const response = await this.fetchImpl(url, {
      method: options.method ?? "GET",
      headers: {
        ...(options.formData || options.body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(options.formData ? { body: options.formData } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 401) this.emit("unauthorized", { status: 401 });
      const details = await readResponseBody(response);
      throw new RagChatHttpError(response.status, getErrorMessage(details, `HTTP ${response.status}`), details);
    }
    if (response.status === 204) return null as T;
    const body = await readResponseBody(response);
    if (body === null) return null as T;
    return body as T;
  }

  private resolveEndpoint(
    name: RagChatEndpointName,
    context: Record<string, unknown>,
    query?: URLSearchParams,
    endpointOverride?: string | ((context: Record<string, unknown>) => string),
  ): string {
    const override = endpointOverride ?? this.options.endpoints?.[name];
    const path = typeof override === "function" ? override(context) : override ?? defaultEndpoint(name, context);
    if (!path) throw new RagChatError(`未配置 ${name} 请求地址`, { code: "ENDPOINT_MISSING" });
    const url = /^https?:\/\//i.test(path) ? path : `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    if (!query || [...query].length === 0) return url;
    return `${url}${url.includes("?") ? "&" : "?"}${query.toString()}`;
  }

  private async cancelAguiRun(sessionId: string, runId?: string): Promise<void> {
    await this.request("aguiCancel", {
      method: "POST",
      body: { threadId: sessionId, ...(runId ? { runId } : {}) },
      context: { sessionId },
    });
  }

  private async resolveHeaders(context: RagChatRequestContext, includeToken = true): Promise<Record<string, string>> {
    if (!includeToken) return {};
    const token = includeToken
      ? this.options.getToken ? await this.options.getToken(context) : this.options.token
      : undefined;
    const dynamic = this.options.getHeaders ? await this.options.getHeaders(context) : this.options.headers;
    const headers: Record<string, string> = {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(dynamic ?? {}),
    };
    return headers;
  }
}

export function createRagChatClient(options: RagChatClientOptions = {}): RagChatClient {
  return new RagChatClient(options);
}

function defaultEndpoint(name: RagChatEndpointName, context: Record<string, unknown>): string {
  const sessionId = encodeURIComponent(String(context.sessionId ?? ""));
  const fileId = encodeURIComponent(String(context.fileId ?? ""));
  switch (name) {
    case "identity": return "/api/auth/me";
    case "logout": return "/api/auth/logout";
    case "switchTenant": return "/api/auth/switch-tenant";
    case "createSession": return "/api/agent/sessions";
    case "listSessions": return "/api/agent/sessions";
    case "getSession": return `/api/agent/sessions/${sessionId}`;
    case "deleteSession": return `/api/agent/sessions/${sessionId}`;
    case "exportSession": return `/api/agent/sessions/${sessionId}/export`;
    case "listSessionsFacets": return "/api/agent/sessions/facets";
    case "getSessionPermissions": return `/api/agent/sessions/${sessionId}/permissions`;
    case "updateSessionPermissions": return `/api/agent/sessions/${sessionId}/permissions`;
    case "getSessionRuntime": return `/api/agent/sessions/${sessionId}/runtime`;
    case "getContextSnapshot": return "/api/agent/context-snapshot";
    case "rollbackAndRetrySession": return `/api/agent/sessions/${sessionId}/rollback-and-retry`;
    case "listMessages": return `/api/agent/sessions/${sessionId}/messages`;
    case "getMessageRunSteps": return `/api/agent/sessions/${sessionId}/messages/${encodeURIComponent(String(context.messageId ?? ""))}/run-steps`;
    case "listFiles": return `/api/agent/sessions/${sessionId}/files`;
    case "uploadFiles": return `/api/agent/sessions/${sessionId}/files/upload`;
    case "validateFiles": return `/api/agent/sessions/${sessionId}/files/validate`;
    case "deleteFile": return `/api/agent/sessions/${sessionId}/files/${fileId}`;
    case "downloadFile": return `/api/agent/sessions/${sessionId}/files/${fileId}/download`;
    case "issueWsTicket": return `/api/agent/sessions/${sessionId}/ws-ticket`;
    case "agui": return "/api/agui";
    case "aguiCancel": return "/api/agui/cancel";
    default: return "";
  }
}

function trimBaseUrl(value = ""): string {
  return String(value).replace(/\/+$/, "");
}

function isTrustedUrl(assetUrl: string, baseUrl: string): boolean {
  const runtimeOrigin = globalThis.location?.origin;
  const resolutionBase = runtimeOrigin || (/^https?:\/\//i.test(baseUrl) ? baseUrl : undefined);
  try {
    const requestOrigin = new URL(assetUrl, resolutionBase).origin;
    const trustedOrigin = baseUrl
      ? new URL(baseUrl, runtimeOrigin).origin
      : runtimeOrigin;
    return Boolean(trustedOrigin) && requestOrigin === trustedOrigin;
  } catch {
    return false;
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function getErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "detail", "error"]) {
      if (typeof record[key] === "string" && record[key]) return record[key] as string;
    }
  }
  return fallback;
}

function clampInteractionTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return 30_000;
  return Math.min(300_000, Math.max(1_000, Number(value)));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new RagChatError("交互处理超时", { code: "CLIENT_TIMEOUT" })), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
