import {
  applyEnvelope,
  createExecutionTreeState,
  getExecutionTree,
} from "@ragsystem/agent-protocol";
import type {
  AgentClient,
  ConnectionStatus,
  ConnectOptions,
  DelegatedToolDeclaration,
  DelegatedToolSpec,
  Envelope,
  ExecutionTree,
  InteractionResponse,
  Observable,
  PendingInteraction,
  RunStatus,
  SessionRuntimePayload,
  SendOptions,
  SendResult,
  ToolCallHandler,
  ToolResult,
  Unsubscribe,
} from "@ragsystem/agent-protocol";

import { EventStream, ObservableValue } from "./observable.js";
import { ChatWebSocketTransport, type WebSocketFactory } from "./websocket-transport.js";
import {
  encodeApprovalRespond,
  encodeDelegateResult,
  encodeResume,
  encodeSend,
  encodeStop,
  encodeToolsRegister,
  encodeUserInputRespond,
} from "./uplink-codec.js";
import { buildSessionWebSocketUrl, extractCursor } from "./websocket-url.js";

/**
 * 单个 Session 的 headless AgentClient 实现。
 *
 * 组合 ChatWebSocketTransport（字节层）+ 协议层投影（execution-tree / runStatus / pendingInteractions
 * 由 agent-protocol 现成函数算出）+ 上行 codec（uplink-codec，对照 ClientToServerEnvelopeSchema）。
 * 职责单一——纯协议消费/发送，不含任何 UI。
 *
 * 设计要点：
 * - delegate_call 不进投影（对齐 frontend-client handleDelegateCall：委托对用户透明），由 delegation 路由独立处理。
 * - hostTools（宿主工具）经 registerTool 注册，握手 connected 时一次性 tools.register 上行。
 * - 重连游标由 client 持有；transport 重连前异步签发新 ticket 并生成最新 URL。
 */

export interface SessionAgentClientOptions {
  /** 后端 origin，如 https://api.host.com。 */
  baseUrl: string;
  sessionId: string;
  /** 每次建立或重连前签发一次性 ticket。 */
  issueWsTicket: (sessionId: string) => Promise<string>;
  reconnect?: ConnectOptions["reconnect"];
  createWebSocket?: WebSocketFactory;
  /** 宿主业务工具（hostTools）；握手时 tools.register 上行，delegate_call 时本地执行。 */
  hostTools?: DelegatedToolSpec[];
}

interface HostToolEntry {
  spec: DelegatedToolSpec;
}

interface RuntimeWaiter {
  resolve(snapshot: SessionRuntimePayload): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionAgentClient implements AgentClient {
  private readonly baseUrl: string;
  private readonly sessionId: string;
  private readonly issueTicket: (sessionId: string) => Promise<string>;
  private readonly reconnectPolicy: ConnectOptions["reconnect"];
  private readonly createWebSocket: WebSocketFactory | undefined;

  private transport: ChatWebSocketTransport | null = null;
  private execState = createExecutionTreeState();
  private cursor: number | null = null;

  private readonly statusValue: ObservableValue<ConnectionStatus>;
  private readonly eventsValue: EventStream;
  private readonly treeValue: ObservableValue<ExecutionTree>;
  private readonly runtimeValue: ObservableValue<SessionRuntimePayload>;
  private readonly runStatusValue: ObservableValue<RunStatus>;
  private readonly pendingValue: ObservableValue<PendingInteraction[]>;

  /** 待决议的 send ack 等待器（单 Session 单 run 串行，至多一个 pending）。 */
  private pendingSendAck: ((result: { ok: boolean; kind?: "agent_run" | "command"; error?: string }) => void) | null = null;
  private pendingResumeAck: ((result: { ok: boolean; error?: string }) => void) | null = null;
  private readonly pendingInteractionAcks = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly runtimeWaiters = new Set<RuntimeWaiter>();
  private hasRuntimeSnapshot = false;

  private delegationEnabled = false;
  private readonly hostTools = new Map<string, HostToolEntry>();
  private readonly toolCallHandlers = new Set<ToolCallHandler>();

  constructor(options: SessionAgentClientOptions) {
    this.baseUrl = options.baseUrl;
    this.sessionId = options.sessionId;
    this.issueTicket = options.issueWsTicket;
    this.reconnectPolicy = options.reconnect;
    this.createWebSocket = options.createWebSocket;
    this.statusValue = new ObservableValue<ConnectionStatus>({ state: "idle" });
    this.eventsValue = new EventStream();
    this.treeValue = new ObservableValue<ExecutionTree>({ root: null, steps: [] });
    this.runtimeValue = new ObservableValue<SessionRuntimePayload>(emptyRuntimeSnapshot());
    this.runStatusValue = new ObservableValue<RunStatus>({ runId: null, state: "idle" });
    this.pendingValue = new ObservableValue<PendingInteraction[]>([]);
    for (const spec of options.hostTools ?? []) {
      this.hostTools.set(spec.name, { spec });
    }
    if (this.hostTools.size > 0) {
      this.delegationEnabled = true;
    }
  }

  /* ---- 连接与生命周期 ---- */

  /**
   * 建立连接。每次先通过 HTTP 签发 ticket，再构造 WS URL；
   * 仍保留可选参数以忠实实现 AgentClient 契约，按契约写 connect({...}) 的消费者不会被静默破坏。
   */
  async connect(_options?: ConnectOptions): Promise<void> {
    void _options;
    if (this.transport) {
      // 已有 transport：仅重连耗尽进 disconnected 时手动恢复，其余状态 no-op 避免重复触发。
      if (this.statusValue.get().state === "disconnected") {
        this.transport.reconnect();
      }
      return;
    }
    this.transport = new ChatWebSocketTransport({
      resolveUrl: () => this.buildUrl(this.cursor),
      sessionId: this.sessionId,
      ...(this.reconnectPolicy ? { reconnect: this.reconnectPolicy } : {}),
      ...(this.createWebSocket ? { createWebSocket: this.createWebSocket } : {}),
      handlers: {
        onStatus: (status) => {
          this.statusValue.set(status);
          if (status.state !== "connected") {
            this.hasRuntimeSnapshot = false;
            if (status.state === "reconnecting" || status.state === "disconnected") {
              this.rejectRuntimeWaiters("连接已断开，无法取得 Session runtime 快照");
            }
          }
          if (status.state === "connected") {
            this.onConnected();
          }
        },
        onEnvelope: (env) => this.handleEnvelope(env),
      },
    });
    this.transport.connect();
    // 首次连接等 WS open（status=connected）才 resolve：保证 await connect() 返回即就绪，
    // connect 返回时已就绪，消费者可以直接 send；否则 send 可能撞“连接未就绪”。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { unsub(); reject(new Error("连接超时")); }, 10000);
      const unsub = this.statusValue.subscribe((s) => {
        if (s.state === "connected") { clearTimeout(timer); unsub(); resolve(); }
        else if (s.state === "disconnected") { clearTimeout(timer); unsub(); reject(new Error("连接失败")); }
      });
    });
  }

  disconnect(): void {
    this.transport?.disconnect();
    this.transport = null;
    this.hasRuntimeSnapshot = false;
    this.rejectRuntimeWaiters("连接已断开");
    if (this.pendingSendAck) {
      this.pendingSendAck({ ok: false, error: "连接已断开" });
      this.pendingSendAck = null;
    }
    if (this.pendingResumeAck) {
      this.pendingResumeAck({ ok: false, error: "连接已断开" });
      this.pendingResumeAck = null;
    }
    for (const pending of this.pendingInteractionAcks.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("连接已断开"));
    }
    this.pendingInteractionAcks.clear();
  }

  get status(): Observable<ConnectionStatus> {
    return this.statusValue;
  }

  /* ---- 投影 ---- */

  get events(): Observable<Envelope> {
    return this.eventsValue;
  }

  get executionTree(): Observable<ExecutionTree> {
    return this.treeValue;
  }

  get runtime(): Observable<SessionRuntimePayload> {
    return this.runtimeValue;
  }

  get runStatus(): Observable<RunStatus> {
    return this.runStatusValue;
  }

  get pendingInteractions(): Observable<PendingInteraction[]> {
    return this.pendingValue;
  }

  registerToolPresentation(_spec: unknown): Unsubscribe {
    void _spec;
    return () => {};
  }

  /* ---- 用户交互与会话控制 ---- */

  /**
   * 发起 run：发 user_driven_change 后等后端 ack(category:"send", ok) 决定 started 终态
   * （后端 ws.ts 会回 ack，run 启动失败时 ok:false）。未连接直接判失败（避免字节静默丢失却
   * 乐观置 running）；5s 未收 ack 也判失败（后端未确认启动），不再把超时当成功。
   * ACK 只表示请求是否被接收；runStatus 仍只由后续 session.runtime 快照派生。
   */
  async send(options: SendOptions): Promise<SendResult> {
    const requestId = options.requestId ?? generateRequestId();
    // 未连接（连接中/重连中/已断开）：字节发不出去，直接判失败，UI 不切 running。
    if (this.statusValue.get().state !== "connected") {
      return { started: false, requestId, error: "连接未就绪" };
    }
    let runtime: SessionRuntimePayload;
    try {
      runtime = await this.waitForRuntimeSnapshot();
    } catch (error) {
      return {
        started: false,
        requestId,
        error: error instanceof Error ? error.message : "无法取得 Session runtime 快照",
      };
    }
    if (!runtime.allowed_actions.includes("send_message")
      && !runtime.allowed_actions.includes("send_followup")) {
      return { started: false, requestId, error: "当前 Session runtime 不允许发送消息" };
    }
    const ackPromise = new Promise<{ ok: boolean; kind?: "agent_run" | "command"; error?: string }>((resolve) => {
      this.pendingSendAck = resolve;
    });
    this.transport?.send(encodeSend(this.sessionId, {
      task: options.task,
      ...(options.selectedLlm ? { selectedLlm: options.selectedLlm } : {}),
      ...(options.attachments ? { attachments: options.attachments } : {}),
      requestId,
      ...(options.uiContext ? { uiContext: options.uiContext } : {}),
    }));
    const result = await Promise.race([
      ackPromise,
      new Promise<{ ok: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, error: "发送超时，未收到确认" }), 5000),
      ),
    ]);
    if (this.pendingSendAck) {
      this.pendingSendAck = null;
    }
    if (result.ok) return { started: true, requestId };
    return { started: false, requestId, ...("error" in result && result.error ? { error: result.error } : {}) };
  }

  stop(): void {
    if (this.statusValue.get().state === "connected"
      && this.hasRuntimeSnapshot
      && this.runtimeValue.get().allowed_actions.includes("stop_run")) {
      this.transport?.send(encodeStop(this.sessionId));
    }
  }

  async respondInteraction(interactionId: string, response: InteractionResponse): Promise<void> {
    if (this.statusValue.get().state !== "connected") throw new Error("连接未就绪");
    const runtime = await this.waitForRuntimeSnapshot();
    if (!runtime.allowed_actions.includes("respond_interaction")) {
      throw new Error("当前 Session runtime 不允许响应交互");
    }
    if (!runtime.pending_interactions.some((item) => item.interaction_id === interactionId)) {
      throw new Error("交互请求已失效，请等待 Session runtime 刷新");
    }
    const ack = this.waitForInteractionAck(interactionId);
    if (response.kind === "user_input") {
      this.transport?.send(encodeUserInputRespond(this.sessionId, interactionId, response.value ?? ""));
    } else {
      this.transport?.send(encodeApprovalRespond(
        this.sessionId,
        interactionId,
        response.approved ?? false,
        response.message,
      ));
    }
    await ack;
  }

  async approve(interactionId: string, approved: boolean, message?: string): Promise<void> {
    await this.respondInteraction(interactionId, { kind: "approval", approved, ...(message ? { message } : {}) });
  }

  async respondInput(interactionId: string, value: string): Promise<void> {
    await this.respondInteraction(interactionId, { kind: "user_input", value });
  }

  async resume(): Promise<boolean> {
    if (this.statusValue.get().state !== "connected") return false;
    const runtime = await this.waitForRuntimeSnapshot();
    const interactionId = runtime.resume_interaction_id;
    if (!interactionId || !runtime.allowed_actions.includes("resume_run")) return false;
    if (this.pendingResumeAck) return false;
    const ack = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      this.pendingResumeAck = resolve;
    });
    this.transport?.send(encodeResume(this.sessionId, interactionId));
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        ack,
        new Promise<{ ok: false; error: string }>((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, error: "恢复超时，未收到确认" }), 8_000);
        }),
      ]);
      return result.ok;
    } finally {
      if (timer) clearTimeout(timer);
      this.pendingResumeAck = null;
    }
  }

  /* ---- 委托模式 ---- */

  enableDelegation(): void {
    this.delegationEnabled = true;
  }

  registerTool(spec: DelegatedToolSpec): Unsubscribe {
    this.hostTools.set(spec.name, { spec });
    this.delegationEnabled = true;
    if (this.statusValue.get().state === "connected") {
      this.registerToolsNow();
    }
    return () => {
      this.hostTools.delete(spec.name);
      if (this.statusValue.get().state === "connected") {
        this.registerToolsNow();
      }
    };
  }

  onToolCall(handler: ToolCallHandler): Unsubscribe {
    this.toolCallHandlers.add(handler);
    return () => {
      this.toolCallHandlers.delete(handler);
    };
  }

  cancelToolCall(callId: string, _reason?: string): void {
    // 一期委托执行通常瞬时完成；取消语义留给宿主 AbortSignal 扩展点，此处记录 no-op。
    void callId;
  }

  /* ---- 逃生舱 ---- */

  sendRaw(message: Record<string, unknown>): void {
    this.transport?.send(message);
  }

  /* ---- 内部 ---- */

  private async buildUrl(cursor: number | null): Promise<string> {
    const ticket = await this.issueTicket(this.sessionId);
    return buildSessionWebSocketUrl({
      backendBase: this.baseUrl,
      sessionId: this.sessionId,
      ticket,
      cursor,
    });
  }

  private onConnected(): void {
    if (this.delegationEnabled && this.hostTools.size > 0) {
      this.registerToolsNow();
    }
  }

  private registerToolsNow(): void {
    const tools: DelegatedToolDeclaration[] = [...this.hostTools.values()].map((entry) => ({
      name: entry.spec.name,
      description: entry.spec.description,
      input_schema: entry.spec.inputSchema,
      ...(entry.spec.riskLevel ? { risk_level: entry.spec.riskLevel } : {}),
      ...(entry.spec.cancellable ? { cancellable: entry.spec.cancellable } : {}),
    }));
    this.transport?.send(encodeToolsRegister(this.sessionId, tools));
  }

  private handleEnvelope(env: Envelope): void {
    // ack 控制帧：不进投影；send ack 决议 pending send。
    if (env.type === "ack") {
      this.handleAck(env);
      return;
    }
    if (env.type === "run_started") {
      // 新 run：重置执行树投影（每 run 独立，避免跨 run 步骤累积）。
      this.execState = createExecutionTreeState();
    }
    // delegate_call：委托对用户透明，不进投影，直接路由本地执行。
    if (env.type === "delegate_call" && this.handleDelegateCall(env)) {
      return;
    }
    if (env.type === "session.runtime") {
      this.applyRuntime(env.payload as SessionRuntimePayload);
    }
    this.eventsValue.emit(env);
    applyEnvelope(this.execState, env);
    this.treeValue.set(getExecutionTree(this.execState));
    const cursor = extractCursor(env);
    if (cursor !== null) {
      this.cursor = cursor;
    }
  }

  private handleAck(env: Envelope): void {
    const payload = env.payload as {
      category?: string;
      ok?: boolean;
      kind?: "agent_run" | "command";
      error?: string;
      ref_call_id?: string;
    } | undefined;
    if (payload?.category === "send" && this.pendingSendAck) {
      const resolve = this.pendingSendAck;
      this.pendingSendAck = null;
      resolve({
        ok: payload.ok ?? false,
        ...(payload.kind ? { kind: payload.kind } : {}),
        ...(payload.error ? { error: payload.error } : {}),
      });
      return;
    }
    if (payload?.category === "interaction" && payload.ref_call_id) {
      const pending = this.pendingInteractionAcks.get(payload.ref_call_id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingInteractionAcks.delete(payload.ref_call_id);
      if (payload.ok) pending.resolve();
      else pending.reject(new Error(payload.error || "交互提交失败"));
      return;
    }
    if (payload?.category === "resume" && this.pendingResumeAck) {
      const resolve = this.pendingResumeAck;
      this.pendingResumeAck = null;
      resolve({
        ok: payload.ok ?? false,
        ...(payload.error ? { error: payload.error } : {}),
      });
    }
  }

  private handleDelegateCall(env: Envelope): boolean {
    const payload = env.payload as { phase?: string; tool?: string; input?: unknown; call_id?: string } | undefined;
    if (!payload || payload.phase !== "request") {
      return false;
    }
    const callId = payload.call_id ?? (typeof env.call_id === "string" ? env.call_id : "");
    const toolName = payload.tool;
    if (!callId || !toolName) {
      return false;
    }
    const entry = this.hostTools.get(toolName);
    if (!entry) {
      this.transport?.send(encodeDelegateResult(this.sessionId, callId, {
        ok: false,
        error: `未注册的宿主工具：${toolName}`,
      }));
      return true;
    }
    const spec = entry.spec;
    const started = Date.now();
    // abort 是协作式：宿主工具需主动检查 signal 才会响应超时；忽略则超时无效（JS 协作式中止固有限制）。
    // cancelToolCall 一期为 no-op，故 signal 当前仅做 60s 超时，不接外部取消。
    const signal = AbortSignal.timeout(60_000);
    void Promise.resolve()
      .then(() => spec.execute(payload.input, {
        callId,
        signal,
        sessionId: this.sessionId,
        runId: typeof env.run_id === "string" ? env.run_id : null,
      }))
      .then((result: ToolResult) => {
        this.transport?.send(encodeDelegateResult(this.sessionId, callId, {
          ok: result.ok,
          ...(result.observation !== undefined ? { observation: result.observation } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
          elapsedMs: result.elapsedMs ?? Date.now() - started,
        }));
      })
      .catch((error: unknown) => {
        this.transport?.send(encodeDelegateResult(this.sessionId, callId, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          elapsedMs: Date.now() - started,
        }));
      });
    return true;
  }

  private applyRuntime(snapshot: SessionRuntimePayload): void {
    this.hasRuntimeSnapshot = true;
    this.runtimeValue.set(snapshot);
    const active = snapshot.active_run;
    const last = snapshot.last_run;
    this.runStatusValue.set(active
      ? { runId: active.run_id, state: snapshot.state, startedAt: active.started_at }
      : last
        ? { runId: last.run_id, state: last.status, finishedAt: last.finished_at }
        : { runId: null, state: snapshot.state });
    this.pendingValue.set(snapshot.pending_interactions.map((item) => {
      const prompt = item.payload.prompt ?? item.payload.message;
      return {
        interactionId: item.interaction_id,
        kind: item.kind,
        status: item.status,
        runId: item.run_id,
        rootRunId: item.root_run_id,
        batchId: item.batch_id,
        ...(item.payload.tool ? { toolName: item.payload.tool } : {}),
        ...(item.payload.input !== undefined ? { arguments: item.payload.input } : {}),
        ...(item.payload.risk_level ? { riskLevel: item.payload.risk_level } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        receivedAt: Date.parse(item.requested_at) || Date.now(),
      };
    }));
    for (const waiter of this.runtimeWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(snapshot);
    }
    this.runtimeWaiters.clear();
  }

  private waitForRuntimeSnapshot(timeoutMs = 10_000): Promise<SessionRuntimePayload> {
    if (this.hasRuntimeSnapshot) return Promise.resolve(this.runtimeValue.get());
    return new Promise((resolve, reject) => {
      const waiter: RuntimeWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.runtimeWaiters.delete(waiter);
          reject(new Error("等待 Session runtime 快照超时"));
        }, timeoutMs),
      };
      this.runtimeWaiters.add(waiter);
    });
  }

  private rejectRuntimeWaiters(message: string): void {
    for (const waiter of this.runtimeWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    this.runtimeWaiters.clear();
  }

  private waitForInteractionAck(interactionId: string, timeoutMs = 8_000): Promise<void> {
    const current = this.pendingInteractionAcks.get(interactionId);
    if (current) {
      clearTimeout(current.timer);
      current.reject(new Error("交互已重新提交"));
      this.pendingInteractionAcks.delete(interactionId);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInteractionAcks.delete(interactionId);
        reject(new Error("交互提交确认超时"));
      }, timeoutMs);
      this.pendingInteractionAcks.set(interactionId, { resolve, reject, timer });
    });
  }
}

function emptyRuntimeSnapshot(): SessionRuntimePayload {
  return {
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
}

function generateRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
