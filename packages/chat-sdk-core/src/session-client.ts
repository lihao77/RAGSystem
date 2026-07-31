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
import type { AguiEvent, AguiRunHandle, AguiRunInput } from "./agui.js";

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
  /** Start an AG-UI SSE run only when WS is not ready. */
  aguiFallback?: (input: AguiRunInput, onEvent: (event: AguiEvent) => void) => AguiRunHandle;
  /** Best-effort server-side cancellation for an active AG-UI fallback run. */
  cancelAguiRun?: (sessionId: string) => Promise<void>;
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
  private readonly aguiFallback: SessionAgentClientOptions["aguiFallback"];
  private readonly cancelAguiRun: SessionAgentClientOptions["cancelAguiRun"];

  private transport: ChatWebSocketTransport | null = null;
  private connectPromise: Promise<void> | null = null;
  private execState = createExecutionTreeState();
  private cursor: number | null = null;

  private readonly statusValue: ObservableValue<ConnectionStatus>;
  private readonly eventsValue: EventStream;
  private readonly treeValue: ObservableValue<ExecutionTree>;
  private readonly runtimeValue: ObservableValue<SessionRuntimePayload>;
  private readonly runStatusValue: ObservableValue<RunStatus>;
  private readonly pendingValue: ObservableValue<PendingInteraction[]>;

  private readonly pendingSendAcks = new Map<
    string,
    (result: { ok: boolean; kind?: "agent_run" | "command"; error?: string }) => void
  >();
  private pendingResumeAck: {
    requestId: string;
    interactionId: string;
    resolve: (result: { ok: boolean; error?: string }) => void;
  } | null = null;
  private uncorrelatedSendAcksQuarantined = false;
  private uncorrelatedResumeAcksQuarantined = false;
  private readonly pendingInteractionAcks = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly runtimeWaiters = new Set<RuntimeWaiter>();
  private hasRuntimeSnapshot = false;

  private delegationEnabled = false;
  private readonly hostTools = new Map<string, HostToolEntry>();
  private readonly toolCallHandlers = new Set<ToolCallHandler>();
  private aguiRun: AguiRunHandle | null = null;

  constructor(options: SessionAgentClientOptions) {
    this.baseUrl = options.baseUrl;
    this.sessionId = options.sessionId;
    this.issueTicket = options.issueWsTicket;
    this.reconnectPolicy = options.reconnect;
    this.createWebSocket = options.createWebSocket;
    this.aguiFallback = options.aguiFallback;
    this.cancelAguiRun = options.cancelAguiRun;
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
    if (this.statusValue.get().state === "connected") {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (!this.transport) {
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
    } else if (this.statusValue.get().state === "disconnected") {
      this.transport.reconnect();
    }

    const pending = this.waitForConnected();
    this.connectPromise = pending;
    const clearPending = () => {
      if (this.connectPromise === pending) this.connectPromise = null;
    };
    pending.then(clearPending, clearPending);
    return pending;
  }

  disconnect(): void {
    this.aguiRun?.abort("session disconnect");
    this.aguiRun = null;
    if (this.transport) {
      this.transport.disconnect();
    } else {
      this.statusValue.set({ state: "disconnected" });
    }
    this.transport = null;
    this.hasRuntimeSnapshot = false;
    this.rejectRuntimeWaiters("连接已断开");
    for (const resolve of this.pendingSendAcks.values()) {
      resolve({ ok: false, error: "连接已断开" });
    }
    this.pendingSendAcks.clear();
    if (this.pendingResumeAck) {
      this.pendingResumeAck.resolve({ ok: false, error: "连接已断开" });
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
      if (this.aguiFallback) {
        try {
          const input: AguiRunInput = {
            threadId: this.sessionId,
            runId: requestId,
            messages: [{ role: "user", content: options.task }],
            ...(options.attachments?.length ? { attachments: options.attachments.map(({ file_id }) => ({ file_id })) } : {}),
            ...(options.selectedLlm ? { selectedLlm: options.selectedLlm } : {}),
          };
          const run = this.aguiFallback(input, (event) => this.handleAguiEvent(event));
          this.aguiRun = run;
          void run.completed.then(
            () => this.clearAguiRun(run),
            () => this.clearAguiRun(run),
          );
          const started = await run.started;
          return { started: true, requestId, ...(started.runId ? { runId: started.runId } : {}) };
        } catch (error) {
          return { started: false, requestId, error: error instanceof Error ? error.message : "AG-UI fallback 启动失败" };
        }
      }
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
    if (this.pendingSendAcks.has(requestId)) {
      return { started: false, requestId, error: "相同 requestId 的发送正在等待确认" };
    }
    const ackPromise = new Promise<{ ok: boolean; kind?: "agent_run" | "command"; error?: string }>((resolve) => {
      this.pendingSendAcks.set(requestId, resolve);
    });
    this.transport?.send(encodeSend(this.sessionId, {
      task: options.task,
      ...(options.selectedLlm ? { selectedLlm: options.selectedLlm } : {}),
      ...(options.attachments ? { attachments: options.attachments } : {}),
      requestId,
      ...(options.uiContext ? { uiContext: options.uiContext } : {}),
    }));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const result = await Promise.race([
      ackPromise,
      new Promise<{ ok: false; error: string; timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: "发送超时，未收到确认", timedOut: true }), 5000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    this.pendingSendAcks.delete(requestId);
    if ("timedOut" in result) {
      this.uncorrelatedSendAcksQuarantined = true;
    }
    if (result.ok) return { started: true, requestId };
    return { started: false, requestId, ...("error" in result && result.error ? { error: result.error } : {}) };
  }

  stop(): void {
    if (this.statusValue.get().state === "connected"
      && this.hasRuntimeSnapshot
      && this.runtimeValue.get().allowed_actions.includes("stop_run")) {
      this.transport?.send(encodeStop(this.sessionId));
    } else if (this.aguiRun) {
      const run = this.aguiRun;
      this.aguiRun = null;
      run.abort("run stopped");
      if (this.cancelAguiRun) {
        void this.cancelAguiRun(this.sessionId).catch(() => {
          // The local abort already stopped delivery; cancellation is best effort.
        });
      }
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
    const requestId = generateRequestId();
    const ack = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      this.pendingResumeAck = { requestId, interactionId, resolve };
    });
    const pending = this.pendingResumeAck;
    this.transport?.send(encodeResume(this.sessionId, interactionId, requestId));
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        ack,
        new Promise<{ ok: false; error: string; timedOut: true }>((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, error: "恢复超时，未收到确认", timedOut: true }), 8_000);
        }),
      ]);
      if ("timedOut" in result) this.uncorrelatedResumeAcksQuarantined = true;
      return result.ok;
    } finally {
      if (timer) clearTimeout(timer);
      if (this.pendingResumeAck === pending) this.pendingResumeAck = null;
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
    this.uncorrelatedSendAcksQuarantined = false;
    this.uncorrelatedResumeAcksQuarantined = false;
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

  private handleAguiEvent(event: AguiEvent): void {
    const envelope = aguiEventToEnvelope(event, this.sessionId);
    if (envelope) this.handleEnvelope(envelope);
  }

  private clearAguiRun(run: AguiRunHandle): void {
    if (this.aguiRun === run) this.aguiRun = null;
  }

  private handleAck(env: Envelope): void {
    const payload = env.payload as {
      category?: string;
      ok?: boolean;
      kind?: "agent_run" | "command";
      error?: string;
      ref_call_id?: string;
      request_id?: string;
    } | undefined;
    if (payload?.category === "send") {
      const requestId = payload.request_id
        ?? (!this.uncorrelatedSendAcksQuarantined && this.pendingSendAcks.size === 1
          ? this.pendingSendAcks.keys().next().value as string | undefined
          : undefined);
      if (!requestId) return;
      const resolve = this.pendingSendAcks.get(requestId);
      if (!resolve) return;
      this.pendingSendAcks.delete(requestId);
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
      const pending = this.pendingResumeAck;
      const correlated = payload.request_id
        ? payload.request_id === pending.requestId
        : !this.uncorrelatedResumeAcksQuarantined && payload.ref_call_id === pending.interactionId;
      if (!correlated) return;
      this.pendingResumeAck = null;
      pending.resolve({
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

  private waitForConnected(timeoutMs = 10_000): Promise<void> {
    if (this.statusValue.get().state === "connected") return Promise.resolve();
    return new Promise((resolve, reject) => {
      let unsubscribe: Unsubscribe | null = null;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error("连接超时")), timeoutMs);
      unsubscribe = this.statusValue.subscribe((status) => {
        if (status.state === "connected") finish();
        else if (status.state === "disconnected") finish(new Error("连接失败"));
      });
      if (settled) unsubscribe();
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

function aguiEventToEnvelope(event: AguiEvent, sessionId: string): Envelope | null {
  const base = {
    session_id: typeof event.threadId === "string" && event.threadId ? event.threadId : sessionId,
    ...(typeof event.runId === "string" && event.runId ? { run_id: event.runId } : {}),
    ...(typeof event.eventSeq === "number" ? { seq: event.eventSeq } : {}),
  };
  switch (event.type) {
    case "RUN_STARTED":
      return { type: "run_started", ...base, run_id: event.runId ?? `agui-${Date.now()}`, payload: {} } as Envelope;
    case "TEXT_MESSAGE_START":
      return { type: "stream_output", ...base, payload: { phase: "first_token", content: "" } } as Envelope;
    case "TEXT_MESSAGE_CONTENT":
      return { type: "stream_output", ...base, payload: { phase: "delta", content: typeof event.delta === "string" ? event.delta : "" } } as Envelope;
    case "TEXT_MESSAGE_END":
      return { type: "stream_output", ...base, payload: { phase: "final", content: "" } } as Envelope;
    case "TOOL_CALL_START":
      return {
        type: "tool_call",
        ...base,
        call_id: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
        payload: {
          phase: "start",
          tool: typeof event.toolCallName === "string" ? event.toolCallName : "tool",
          input: {},
        },
      } as Envelope;
    case "TOOL_CALL_RESULT":
      return {
        type: "tool_result",
        ...base,
        call_id: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
        payload: {
          phase: "end",
          tool: "tool",
          ok: true,
          observation: typeof event.content === "string" ? event.content : "",
        },
      } as Envelope;
    case "RUN_FINISHED":
      const outcome = event.outcome && typeof event.outcome === "object" && !Array.isArray(event.outcome)
        ? event.outcome as { type?: unknown }
        : undefined;
      return {
        type: "run_ended",
        ...base,
        run_id: event.runId ?? `agui-${Date.now()}`,
        payload: { status: outcome?.type === "interrupt" ? "suspended" : "completed" },
      } as Envelope;
    case "RUN_ERROR":
      return {
        type: "error",
        ...base,
        payload: { code: "agui_run_error", message: typeof event.message === "string" ? event.message : "AG-UI run failed" },
      } as Envelope;
    case "STATE_SNAPSHOT":
      if (isRuntimeSnapshot(event.snapshot)) {
        return { type: "session.runtime", ...base, payload: event.snapshot } as Envelope;
      }
      return null;
    case "CUSTOM":
      if (event.name === "session.runtime" && isRuntimeSnapshot(event.value)) {
        return { type: "session.runtime", ...base, payload: event.value } as Envelope;
      }
      return null;
    default:
      return null;
  }
}

function isRuntimeSnapshot(value: unknown): value is SessionRuntimePayload {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { state?: unknown }).state === "string"
    && Array.isArray((value as { allowed_actions?: unknown }).allowed_actions)
    && Array.isArray((value as { pending_interactions?: unknown }).pending_interactions);
}
