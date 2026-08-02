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
  cancelAguiRun?: (sessionId: string, runId?: string) => Promise<void>;
}

/** Session connection controls for hosts that loaded a durable message watermark first. */
export interface SessionConnectOptions {
  afterEventSeq?: number;
  historySnapshot?: boolean;
}

interface HostToolEntry {
  spec: DelegatedToolSpec;
}

interface RuntimeWaiter {
  resolve(snapshot: SessionRuntimePayload): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface AguiSegmentContext {
  input: AguiRunInput;
  startedAt: string;
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
  private pendingConnectOptionsKey: string | null = null;
  private execState = createExecutionTreeState();
  private cursor: number | null = null;
  private historySnapshotPending = false;

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
  private readonly interactionAckQuarantine = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runtimeWaiters = new Set<RuntimeWaiter>();
  private hasRuntimeSnapshot = false;

  private delegationEnabled = false;
  private readonly hostTools = new Map<string, HostToolEntry>();
  private readonly toolCallHandlers = new Set<ToolCallHandler>();
  private aguiRun: AguiRunHandle | null = null;
  private aguiCancelPromise: Promise<void> | null = null;
  private readonly aguiInterrupts = new Map<string, {
    runId: string;
    kind: "approval" | "user_input";
    toolCallId?: string;
    toolName?: string;
    arguments?: unknown;
    prompt?: string;
  }>();
  private readonly aguiPendingInteractions = new Map<string, PendingInteraction>();
  private readonly aguiToolArgs = new Map<string, string>();
  private readonly aguiToolNames = new Map<string, string>();
  private readonly sequenceOwners = new Map<number, "ws" | "agui">();
  private readonly seenAguiEvents = new Set<string>();
  private readonly activeToolCalls = new Map<string, AbortController>();
  /** Invalidates callbacks retained by an aborted or terminal SSE segment. */
  private aguiGeneration = 0;

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
  connect(options: SessionConnectOptions = {}): Promise<void> {
    const optionsKey = JSON.stringify({
      afterEventSeq: options.afterEventSeq ?? null,
      historySnapshot: options.historySnapshot === true,
    });
    if (this.statusValue.get().state === "connected") {
      if (options.afterEventSeq !== undefined || options.historySnapshot) {
        this.disconnect();
      } else {
        return Promise.resolve();
      }
    }
    if (this.connectPromise) {
      if (this.pendingConnectOptionsKey !== optionsKey) {
        const rejected = Promise.reject(new Error("连接正在建立，不能应用不同的连接选项"));
        void rejected.catch(() => undefined);
        return rejected;
      }
      return this.connectPromise;
    }
    if (options.afterEventSeq !== undefined) {
      this.cursor = options.afterEventSeq;
    }
    if (options.historySnapshot) {
      this.historySnapshotPending = true;
    }
    if (!this.transport) {
      this.transport = new ChatWebSocketTransport({
        resolveUrl: () => this.buildUrl(this.cursor, this.historySnapshotPending),
        initialCursor: this.cursor,
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
          onEnvelope: (env) => this.handleEnvelope(env, "ws"),
        },
      });
      this.transport.connect();
    } else if (this.statusValue.get().state === "disconnected") {
      this.transport.reconnect();
    }

    const pending = this.waitForConnected();
    this.connectPromise = pending;
    this.pendingConnectOptionsKey = optionsKey;
    // Hosts may intentionally start a connection in the background and switch
    // sessions before it settles. Keep the returned Promise rejectable for
    // awaited callers, while preventing an abandoned attempt from becoming a
    // global unhandled rejection during disconnect().
    void pending.catch(() => undefined);
    const clearPending = () => {
      if (this.connectPromise === pending) this.connectPromise = null;
      if (this.pendingConnectOptionsKey === optionsKey) this.pendingConnectOptionsKey = null;
    };
    pending.then(clearPending, clearPending);
    return pending;
  }

  disconnect(): void {
    this.connectPromise = null;
    this.pendingConnectOptionsKey = null;
    const cancelRunId = this.runStatusValue.get().runId;
    const hadAguiRun = Boolean(this.aguiRun) || this.aguiInterrupts.size > 0;
    this.aguiGeneration += 1;
    this.aguiRun?.abort("session disconnect");
    this.aguiRun = null;
    if (hadAguiRun && this.cancelAguiRun && !this.aguiCancelPromise) {
      const cancellation = this.cancelAguiRun(this.sessionId, cancelRunId ?? undefined).catch(() => undefined);
      this.aguiCancelPromise = cancellation;
      void cancellation.finally(() => {
        if (this.aguiCancelPromise === cancellation) this.aguiCancelPromise = null;
      });
    }
    this.aguiInterrupts.clear();
    this.aguiPendingInteractions.clear();
    this.aguiToolArgs.clear();
    this.aguiToolNames.clear();
    this.abortActiveToolCalls("session disconnect");
    this.activeToolCalls.clear();
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
    for (const timer of this.interactionAckQuarantine.values()) clearTimeout(timer);
    this.interactionAckQuarantine.clear();
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
    if (this.aguiRun || this.aguiInterrupts.size > 0) {
      return { started: false, requestId, error: "已有 AG-UI run 正在执行或等待交互" };
    }
    if (this.aguiCancelPromise) await this.aguiCancelPromise;
    // 未连接（连接中/重连中/已断开）：字节发不出去，直接判失败，UI 不切 running。
    if (this.statusValue.get().state !== "connected") {
      if (this.aguiFallback) {
        try {
          if (this.aguiCancelPromise) await this.aguiCancelPromise;
          if (this.aguiRun || this.aguiInterrupts.size > 0) {
            return { started: false, requestId, error: "已有 AG-UI run 正在执行或等待交互" };
          }
          const input: AguiRunInput = {
            threadId: this.sessionId,
            runId: requestId,
            messages: [{ role: "user", content: options.task }],
            ...(options.attachments?.length ? { attachments: options.attachments.map(({ file_id }) => ({ file_id })) } : {}),
            ...(options.selectedLlm ? { selectedLlm: options.selectedLlm } : {}),
            ...(options.uiContext ? { forwardedProps: { uiContext: options.uiContext } } : {}),
            ...(this.hostTools.size > 0 ? { tools: this.aguiToolDeclarations() } : {}),
          };
          const run = this.startAguiSegment(input);
          const started = await run.started;
          return { started: true, kind: "agent_run", requestId, ...(started.runId ? { runId: started.runId } : {}) };
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
    if (result.ok) return { started: true, requestId, ...(result.kind ? { kind: result.kind } : {}) };
    return { started: false, requestId, ...("error" in result && result.error ? { error: result.error } : {}) };
  }

  stop(): void {
    // An AG-UI segment owns its interrupt/resume lifecycle even if the WS
    // socket recovers in parallel. Sending stop over WS in that state leaves
    // the gateway's in-memory interrupt record unresolved and the SSE run
    // can never resume.
    if (this.aguiRun || this.aguiInterrupts.size > 0) {
      const run = this.aguiRun;
      const cancelRunId = this.runStatusValue.get().runId;
      this.abortActiveToolCalls("run stopped");
      this.aguiGeneration += 1;
      this.aguiRun = null;
      run?.abort("run stopped");
      this.aguiInterrupts.clear();
      this.aguiPendingInteractions.clear();
      this.pendingValue.set([]);
      this.runStatusValue.set({ runId: null, state: "idle" });
      this.publishAguiRuntime("idle", null, [], undefined, {
        status: "interrupted",
        runId: cancelRunId,
      });
      if (this.cancelAguiRun) {
        const cancellation = this.cancelAguiRun(this.sessionId, cancelRunId ?? undefined)
          .catch(() => {
            // The local abort already stopped delivery; cancellation is best effort.
          });
        this.aguiCancelPromise = cancellation;
        void cancellation.finally(() => {
          if (this.aguiCancelPromise === cancellation) this.aguiCancelPromise = null;
        });
      }
      return;
    }
    if (this.statusValue.get().state === "connected"
      && this.hasRuntimeSnapshot
      && this.runtimeValue.get().allowed_actions.includes("stop_run")) {
      this.abortActiveToolCalls("run stopped");
      this.transport?.send(encodeStop(this.sessionId));
    }
  }

  async respondInteraction(interactionId: string, response: InteractionResponse): Promise<void> {
    // Prefer the AG-UI resume path for interrupts created by the SSE gateway,
    // regardless of whether the WebSocket has recovered since the prompt was
    // presented. A WS interaction ACK cannot resolve the AG-UI interrupt
    // machine.
    if (this.aguiInterrupts.has(interactionId)) {
      await this.resumeAguiInterrupt(interactionId, response);
      return;
    }
    if (this.statusValue.get().state !== "connected") {
      throw new Error("连接未就绪");
    }
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
      const current = this.hostTools.get(spec.name);
      if (current?.spec !== spec) return;
      this.hostTools.delete(spec.name);
      if (this.statusValue.get().state === "connected") {
        this.registerToolsNow();
      }
    };
  }

  /** Remove a tool from the current session connection, if it is still current. */
  unregisterTool(spec: DelegatedToolSpec): void {
    const current = this.hostTools.get(spec.name);
    if (current?.spec !== spec) return;
    this.hostTools.delete(spec.name);
    if (this.statusValue.get().state === "connected") this.registerToolsNow();
  }

  onToolCall(handler: ToolCallHandler): Unsubscribe {
    this.toolCallHandlers.add(handler);
    return () => {
      this.toolCallHandlers.delete(handler);
    };
  }

  removeToolCallHandler(handler: ToolCallHandler): void {
    this.toolCallHandlers.delete(handler);
  }

  cancelToolCall(callId: string, reason?: string): void {
    this.activeToolCalls.get(callId)?.abort(reason || "tool call cancelled");
  }

  private abortActiveToolCalls(reason: string): void {
    for (const controller of this.activeToolCalls.values()) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  }

  /* ---- 逃生舱 ---- */

  sendRaw(message: Record<string, unknown>): void {
    this.transport?.send(message);
  }

  /* ---- 内部 ---- */

  private async buildUrl(cursor: number | null, historySnapshot = false): Promise<string> {
    const ticket = await this.issueTicket(this.sessionId);
    return buildSessionWebSocketUrl({
      backendBase: this.baseUrl,
      sessionId: this.sessionId,
      ticket,
      cursor,
      ...(historySnapshot ? { historySnapshot: true } : {}),
    });
  }

  private onConnected(): void {
    // A timeout may leave an old uncorrelated ACK in the durable replay. Keep
    // the quarantine across reconnects; clearing it here can resolve a newer
    // request with that stale ACK.
    if (this.delegationEnabled) {
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

  private handleEnvelope(env: Envelope, source: "ws" | "agui" = "ws"): void {
    if (source === "ws" && this.aguiRun) {
      // AG-UI owns delivery while its SSE segment is active. The WS socket
      // may recover in parallel, but must not project the same session run.
      return;
    }
    const eventSeq = typeof env.seq === "number" ? env.seq : null;
    if (eventSeq !== null) {
      const owner = this.sequenceOwners.get(eventSeq);
      if (source === "ws" && owner === "agui") return;
      if (source === "agui" && owner === "ws") return;
      this.sequenceOwners.set(eventSeq, source);
      while (this.sequenceOwners.size > 512) {
        const oldest = this.sequenceOwners.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        this.sequenceOwners.delete(oldest);
      }
    }
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
      if (!(env.payload as SessionRuntimePayload).active_run) {
        this.historySnapshotPending = false;
      }
    }
    if (env.type === "session.reconnect") {
      const payload = env.payload as { phase?: string; replay_source?: string } | undefined;
      if (payload?.phase === "end" && payload.replay_source === "active_run_snapshot") {
        this.historySnapshotPending = false;
      }
    }
    applyEnvelope(this.execState, env);
    this.treeValue.set(getExecutionTree(this.execState));
    const cursor = extractCursor(env);
    if (cursor !== null) {
      this.cursor = Math.max(this.cursor ?? 0, cursor);
      this.transport?.syncCursor(this.cursor);
    }
    this.eventsValue.emit(env);
  }

  private handleAguiEvent(event: AguiEvent, context?: AguiSegmentContext): void {
    const eventSeq = typeof event.eventSeq === "number" ? event.eventSeq : null;
    // Without a sequence number, multiple TEXT_MESSAGE_CONTENT / TOOL_CALL_ARGS
    // events intentionally share the same type and message id. They are not
    // duplicates, so only sequence-bearing AG-UI events are de-duplicated.
    if (eventSeq !== null) {
      const eventKey = `${eventSeq}:${event.type}:${String(event.toolCallId ?? event.messageId ?? "")}`;
      if (this.seenAguiEvents.has(eventKey)) return;
      this.seenAguiEvents.add(eventKey);
      if (this.seenAguiEvents.size > 1024) {
        const oldest = this.seenAguiEvents.values().next().value as string | undefined;
        if (oldest) this.seenAguiEvents.delete(oldest);
      }
    }
    if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
      // The SSE segment has reached its terminal boundary. A resume request
      // may be started from the event callback before completed settles.
      this.aguiRun = null;
    }
    if (event.type === "TOOL_CALL_START" && typeof event.toolCallId === "string") {
      if (typeof event.toolCallName === "string") this.aguiToolNames.set(event.toolCallId, event.toolCallName);
      this.aguiToolArgs.set(event.toolCallId, "");
    } else if (event.type === "TOOL_CALL_ARGS" && typeof event.toolCallId === "string") {
      this.aguiToolArgs.set(event.toolCallId, (this.aguiToolArgs.get(event.toolCallId) ?? "") + (typeof event.delta === "string" ? event.delta : ""));
    }
    const envelope = aguiEventToEnvelope(event, this.sessionId, this.aguiToolArgs, this.aguiToolNames);
    if (envelope) this.handleEnvelope(envelope, "agui");
    if (event.type === "RUN_STARTED") {
      this.publishAguiRuntime("running", event.runId ?? context?.input.runId ?? null, [], context);
      this.runStatusValue.set({ runId: event.runId ?? null, state: "running" });
    } else if (event.type === "RUN_FINISHED") {
      const outcome = event.outcome && typeof event.outcome === "object" && !Array.isArray(event.outcome)
        ? event.outcome as { type?: unknown; interrupts?: unknown[] }
        : undefined;
      if (outcome?.type === "interrupt") {
        const pending = this.captureAguiInterrupts(event, outcome.interrupts);
        // Delegated host-tool interrupts are resumed automatically and do not
        // leave a user-facing pending interaction. Keep the synthetic runtime
        // valid (suspended requires at least one pending item or resume id).
        this.publishAguiRuntime(pending.length > 0 ? "suspended" : "running", event.runId ?? context?.input.runId ?? null, pending, context);
        this.runStatusValue.set({ runId: event.runId ?? null, state: "interrupted" });
      } else {
        this.publishAguiRuntime("idle", null, [], context, {
          status: "completed",
          runId: event.runId ?? context?.input.runId ?? null,
        });
        this.runStatusValue.set({ runId: event.runId ?? null, state: "completed" });
      }
    } else if (event.type === "RUN_ERROR") {
      this.runStatusValue.set({ runId: event.runId ?? null, state: "failed" });
      this.handleEnvelope({
        type: "run_ended",
        session_id: this.sessionId,
        ...(event.runId ? { run_id: event.runId } : {}),
        ...(event.eventSeq !== undefined ? { seq: event.eventSeq } : {}),
        payload: { status: "failed", error: event.message },
      } as Envelope, "agui");
      this.publishAguiRuntime("idle", null, [], context, {
        status: "failed",
        runId: event.runId ?? context?.input.runId ?? null,
      });
    }
  }

  private clearAguiRun(run: AguiRunHandle): void {
    if (this.aguiRun === run) this.aguiRun = null;
  }

  private startAguiSegment(input: AguiRunInput): AguiRunHandle {
    if (!this.aguiFallback) throw new Error("AG-UI fallback 未配置");
    let started = false;
    const generation = ++this.aguiGeneration;
    const context: AguiSegmentContext = { input, startedAt: new Date().toISOString() };
    const run = this.aguiFallback(input, (event) => {
      if (generation !== this.aguiGeneration) return;
      if (event.type === "RUN_STARTED") started = true;
      this.handleAguiEvent(event, context);
      if ((event.type === "RUN_FINISHED" || event.type === "RUN_ERROR")
        && generation === this.aguiGeneration) {
        this.aguiGeneration += 1;
      }
    });
    if (generation === this.aguiGeneration) {
      this.aguiRun = run;
    } else {
      // A custom fallback may emit a terminal event synchronously before it
      // returns its handle. Do not resurrect that already-finished segment.
      run.abort("AG-UI segment already finished");
    }
    void run.completed.then(
      () => {
        if (this.aguiRun === run && generation === this.aguiGeneration) {
          this.aguiGeneration += 1;
        }
        this.clearAguiRun(run);
      },
      (error: unknown) => {
        // stop()/disconnect() intentionally detach the run before aborting it;
        // an AbortError from that path must not turn the stopped run into a
        // later failed run. Only project failures for the still-owned segment.
        if (this.aguiRun !== run || generation !== this.aguiGeneration) return;
        this.aguiGeneration += 1;
        this.clearAguiRun(run);
        if (!started) return;
        this.runStatusValue.set({ runId: input.runId ?? null, state: "failed" });
        const errorEnvelope = {
          type: "error",
          session_id: this.sessionId,
          ...(input.runId ? { run_id: input.runId } : {}),
          payload: { code: "agui_stream_failed", message: error instanceof Error ? error.message : String(error) },
        } as Envelope;
        this.handleEnvelope(errorEnvelope, "agui");
        const errorMessage = (errorEnvelope.payload as { message?: string }).message;
        this.handleEnvelope({
          type: "run_ended",
          session_id: this.sessionId,
          ...(input.runId ? { run_id: input.runId } : {}),
          payload: { status: "failed", ...(errorMessage ? { error: errorMessage } : {}) },
        } as Envelope, "agui");
        this.publishAguiRuntime("idle", null, [], context, {
          status: "failed",
          runId: input.runId ?? null,
        });
      },
    );
    return run;
  }

  private aguiToolDeclarations(): NonNullable<AguiRunInput["tools"]> {
    return [...this.hostTools.values()].map(({ spec }) => ({
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
      ...(spec.riskLevel ? { riskLevel: spec.riskLevel } : {}),
    }));
  }

  /**
   * AG-UI has no session.runtime frame of its own. Publish a protocol-shaped
   * runtime snapshot so hosts can use the same loading/interaction controls
   * for SSE fallback runs as they do for WebSocket runs.
   */
  private publishAguiRuntime(
    state: "running" | "suspended" | "idle",
    runId: string | null,
    pending: PendingInteraction[],
    context?: AguiSegmentContext,
    terminal?: { status: "completed" | "failed" | "interrupted"; runId: string | null },
  ): void {
    const current = this.runtimeValue.get();
    const effectiveRunId = runId || (state === "idle" ? null : `agui-${Date.now()}`);
    const startedAt = context?.startedAt ?? current.active_run?.started_at ?? new Date().toISOString();
    let task = current.active_run?.task ?? "";
    for (const message of context?.input.messages ?? []) {
      if (message.role === "user" && typeof message.content === "string") task = message.content;
    }
    const activeRun = effectiveRunId
      ? {
        run_id: effectiveRunId,
        status: state === "suspended" ? "suspended" as const : "running" as const,
        execution_owner: state === "suspended" ? "detached" as const : "attached" as const,
        task,
        request_id: context?.input.runId ?? null,
        execution_kind: "agui_stream",
        started_at: startedAt,
        updated_at: new Date().toISOString(),
      }
      : null;
    const runtimePending = pending.map((item) => ({
      interaction_id: item.interactionId,
      run_id: item.runId,
      root_run_id: item.rootRunId,
      batch_id: item.batchId,
      kind: item.kind,
      status: item.status,
      requested_at: new Date(item.receivedAt).toISOString(),
      payload: {
        kind: item.kind,
        phase: "required" as const,
        ...(item.toolName ? { tool: item.toolName } : {}),
        ...(item.arguments !== undefined ? { input: item.arguments } : {}),
        ...(item.prompt ? { prompt: item.prompt } : {}),
      },
    }));
    const lastRun = terminal?.runId
      ? {
        run_id: terminal.runId,
        status: terminal.status,
        task,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      }
      : current.last_run;
    const snapshot: SessionRuntimePayload = {
      state,
      load_strategy: state === "running"
        ? "attach_run"
        : state === "suspended"
          ? "restore_suspended_run_and_present_interactions"
          : "history",
      allowed_actions: state === "running"
        ? ["send_followup", "stop_run"]
        : state === "suspended"
          ? ["respond_interaction", "stop_run"]
          : ["send_message", "start_maintenance"],
      active_run: activeRun,
      last_run: lastRun,
      pending_interactions: runtimePending,
      resume_interaction_id: null,
      maintenance: null,
      observed_at: new Date().toISOString(),
    };
    this.handleEnvelope({
      type: "session.runtime",
      session_id: this.sessionId,
      ...(effectiveRunId ? { run_id: effectiveRunId } : {}),
      payload: snapshot,
    } as Envelope, "agui");
  }

  private captureAguiInterrupts(event: AguiEvent, rawInterrupts: unknown): PendingInteraction[] {
    if (!Array.isArray(rawInterrupts)) return [];
    const pending: PendingInteraction[] = [];
    const delegated: Array<{ id: string; toolName?: string; arguments?: unknown }> = [];
    for (const raw of rawInterrupts) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const interrupt = raw as Record<string, unknown>;
      const id = typeof interrupt.id === "string" ? interrupt.id : "";
      if (!id) continue;
      const reason = interrupt.reason === "input_required" ? "user_input" : "approval";
      const metadata = interrupt.metadata && typeof interrupt.metadata === "object" && !Array.isArray(interrupt.metadata)
        ? interrupt.metadata as Record<string, unknown>
        : {};
      const toolCallId = typeof interrupt.toolCallId === "string" ? interrupt.toolCallId : undefined;
      const toolName = typeof metadata.toolName === "string" ? metadata.toolName : undefined;
      const argumentsValue = metadata.arguments;
      this.aguiInterrupts.set(id, {
        runId: event.runId ?? `agui-${Date.now()}`,
        kind: reason,
        ...(toolCallId ? { toolCallId } : {}),
        ...(toolName ? { toolName } : {}),
        ...(argumentsValue !== undefined ? { arguments: argumentsValue } : {}),
        ...(typeof interrupt.message === "string" ? { prompt: interrupt.message } : {}),
      });
      const item: PendingInteraction = {
        interactionId: id,
        kind: reason,
        status: "suspended",
        runId: event.runId ?? id,
        rootRunId: event.runId ?? id,
        batchId: id,
        ...(toolName ? { toolName } : {}),
        ...(argumentsValue !== undefined ? { arguments: argumentsValue } : {}),
        ...(typeof interrupt.message === "string" ? { prompt: interrupt.message } : {}),
        receivedAt: Date.now(),
      };
      const delegatedTool = reason === "approval" && toolName && this.hostTools.has(toolName);
      if (!delegatedTool) {
        this.aguiPendingInteractions.set(id, item);
        pending.push(item);
      } else {
        delegated.push({ id, ...(toolName ? { toolName } : {}), ...(argumentsValue !== undefined ? { arguments: argumentsValue } : {}) });
      }
    }
    if (pending.length > 0) {
      this.pendingValue.set([
        ...this.pendingValue.get().filter((item) => !this.aguiPendingInteractions.has(item.interactionId)),
        ...this.aguiPendingInteractions.values(),
      ]);
    }
    for (const item of delegated) {
      void this.executeAguiToolInterrupt(item.id, item);
    }
    return pending;
  }

  private async executeAguiToolInterrupt(
    interactionId: string,
    interrupt: { toolName?: string; arguments?: unknown },
  ): Promise<void> {
    const tool = interrupt.toolName ? this.hostTools.get(interrupt.toolName) : undefined;
    if (!tool) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("tool call timeout"), 60_000);
    this.activeToolCalls.set(interactionId, controller);
    try {
      const handler = [...this.toolCallHandlers][0];
      const result = handler
        ? await handler({ callId: interactionId, toolName: interrupt.toolName ?? tool.spec.name, arguments: interrupt.arguments, runId: null })
        : await tool.spec.execute(interrupt.arguments, {
          callId: interactionId,
          signal: controller.signal,
          sessionId: this.sessionId,
          runId: null,
        });
      if (controller.signal.aborted) {
        await this.resumeAguiInterruptWithPayload(interactionId, {
          ok: false,
          error: controller.signal.reason instanceof Error
            ? controller.signal.reason.message
            : String(controller.signal.reason || "tool call cancelled"),
        });
        return;
      }
      await this.resumeAguiInterruptWithPayload(interactionId, result);
    } catch (error) {
      await this.resumeAguiInterruptWithPayload(interactionId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    } finally {
      clearTimeout(timeout);
      if (this.activeToolCalls.get(interactionId) === controller) this.activeToolCalls.delete(interactionId);
    }
  }

  private async resumeAguiInterrupt(interactionId: string, response: InteractionResponse): Promise<void> {
    const payload = response.kind === "user_input"
      ? { value: response.value ?? "" }
      : { approved: response.approved ?? false, ...(response.message ? { message: response.message } : {}) };
    await this.resumeAguiInterruptWithPayload(interactionId, payload);
  }

  private async resumeAguiInterruptWithPayload(interactionId: string, payload: unknown): Promise<void> {
    const interrupt = this.aguiInterrupts.get(interactionId);
    if (!interrupt || !this.aguiFallback) throw new Error("AG-UI 交互已失效");
    const pending = this.aguiPendingInteractions.get(interactionId);
    this.aguiInterrupts.delete(interactionId);
    this.aguiPendingInteractions.delete(interactionId);
    this.pendingValue.set([...this.pendingValue.get().filter((item) => item.interactionId !== interactionId)]);
    try {
      const run = this.startAguiSegment({
        threadId: this.sessionId,
        runId: generateRequestId(),
        resume: [{ interruptId: interactionId, status: "resolved", payload }],
        ...(this.hostTools.size > 0 ? { tools: this.aguiToolDeclarations() } : {}),
      });
      await run.started;
    } catch (error) {
      if (pending) {
        this.aguiInterrupts.set(interactionId, interrupt);
        this.aguiPendingInteractions.set(interactionId, pending);
        this.pendingValue.set([...this.pendingValue.get(), pending]);
      }
      throw error;
    }
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
      this.clearInteractionAckQuarantine(payload.ref_call_id);
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
    const handler = [...this.toolCallHandlers][0];
    if (!entry && !handler) {
      this.transport?.send(encodeDelegateResult(this.sessionId, callId, {
        ok: false,
        error: `未注册的宿主工具：${toolName}`,
      }));
      return true;
    }
    const started = Date.now();
    // Abort is cooperative, but unlike the old no-op implementation it now
    // gives stop/cancel/disconnect a signal to propagate to host tools.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("tool call timeout"), 60_000);
    this.activeToolCalls.set(callId, controller);
    const signal = controller.signal;
    void Promise.resolve()
      .then(() => handler
        ? handler({
          callId,
          toolName,
          arguments: payload.input,
          runId: typeof env.run_id === "string" ? env.run_id : null,
        })
        : entry!.spec.execute(payload.input, {
          callId,
          signal,
          sessionId: this.sessionId,
          runId: typeof env.run_id === "string" ? env.run_id : null,
        }))
      .then((result: ToolResult) => {
        if (signal.aborted) {
          this.transport?.send(encodeDelegateResult(this.sessionId, callId, {
            ok: false,
            error: signal.reason instanceof Error ? signal.reason.message : String(signal.reason || "tool call cancelled"),
            elapsedMs: Date.now() - started,
          }));
          return;
        }
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
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.activeToolCalls.get(callId) === controller) this.activeToolCalls.delete(callId);
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
    const runtimePending = snapshot.pending_interactions.map((item) => {
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
    });
    const mergedPending = new Map<string, PendingInteraction>();
    for (const item of runtimePending) mergedPending.set(item.interactionId, item as PendingInteraction);
    // session.runtime is authoritative for ids it knows. Keep AG-UI-only
    // interrupts, but never let a stale SSE item overwrite a resolved runtime
    // interaction after the WebSocket catches up.
    for (const item of this.aguiPendingInteractions.values()) {
      if (!mergedPending.has(item.interactionId)) mergedPending.set(item.interactionId, item);
    }
    this.pendingValue.set([...mergedPending.values()]);
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
    if (this.interactionAckQuarantine.has(interactionId)) {
      return Promise.reject(new Error("上一次交互提交仍在等待迟到确认，请稍后重试"));
    }
    const current = this.pendingInteractionAcks.get(interactionId);
    if (current) {
      clearTimeout(current.timer);
      current.reject(new Error("交互已重新提交"));
      this.pendingInteractionAcks.delete(interactionId);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInteractionAcks.delete(interactionId);
        const quarantineTimer = setTimeout(() => {
          this.interactionAckQuarantine.delete(interactionId);
        }, timeoutMs);
        this.interactionAckQuarantine.set(interactionId, quarantineTimer);
        reject(new Error("交互提交确认超时"));
      }, timeoutMs);
      this.pendingInteractionAcks.set(interactionId, { resolve, reject, timer });
    });
  }

  private clearInteractionAckQuarantine(interactionId: string): void {
    const timer = this.interactionAckQuarantine.get(interactionId);
    if (!timer) return;
    clearTimeout(timer);
    this.interactionAckQuarantine.delete(interactionId);
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

function aguiEventToEnvelope(
  event: AguiEvent,
  sessionId: string,
  toolArgs = new Map<string, string>(),
  toolNames = new Map<string, string>(),
): Envelope | null {
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
    case "REASONING_MESSAGE_START":
      return { type: "stream_output", ...base, payload: { phase: "intent_delta", content: "" } } as Envelope;
    case "REASONING_MESSAGE_CONTENT":
      return { type: "stream_output", ...base, payload: { phase: "intent_delta", content: typeof event.delta === "string" ? event.delta : "" } } as Envelope;
    case "REASONING_MESSAGE_END":
      return { type: "stream_output", ...base, payload: { phase: "intent_complete", content: "" } } as Envelope;
    case "TOOL_CALL_START":
      return {
        type: "tool_call",
        ...base,
        call_id: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
        payload: {
          phase: "start",
          tool: typeof event.toolCallName === "string" ? event.toolCallName : "tool",
          ...(event.input !== undefined ? { input: event.input } : {}),
        },
      } as Envelope;
    case "TOOL_CALL_END":
      // AG-UI marks the end of argument generation here. The actual tool
      // outcome arrives as TOOL_CALL_RESULT; emitting another tool_call/start
      // would create a duplicate running node in the execution tree.
      return null;
    case "TOOL_CALL_RESULT":
      return {
        type: "tool_result",
        ...base,
        call_id: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
        payload: {
          phase: "end",
          tool: typeof event.toolCallName === "string"
            ? event.toolCallName
            : (typeof event.toolCallId === "string" ? (toolNames.get(event.toolCallId) ?? "tool") : "tool"),
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
