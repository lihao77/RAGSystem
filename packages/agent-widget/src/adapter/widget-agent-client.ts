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
  SendOptions,
  SendResult,
  ToolCallHandler,
  ToolResult,
  Unsubscribe,
} from "@ragsystem/agent-protocol";

import { EventStream, ObservableValue } from "./observable.js";
import { WidgetWsTransport } from "./ws-transport.js";
import {
  encodeApprovalRespond,
  encodeDelegateResult,
  encodeSend,
  encodeStop,
  encodeToolsRegister,
  encodeUserInputRespond,
} from "./uplink-codec.js";
import { buildWidgetWsUrl, extractCursor } from "./ws-url.js";

/**
 * widget 浏览器端 AgentClient 实现。
 *
 * 组合 WidgetWsTransport（字节层）+ 协议层投影（execution-tree / runStatus / pendingInteractions
 * 由 agent-protocol 现成函数算出）+ 上行 codec（uplink-codec，对照 ClientToServerEnvelopeSchema）。
 * 职责单一——纯协议消费/发送，不含任何 UI。
 *
 * 设计要点：
 * - delegate_call 不进投影（对齐 frontend-client handleDelegateCall：委托对用户透明），由 delegation 路由独立处理。
 * - hostTools（宿主工具）经 registerTool 注册，握手 connected 时一次性 tools.register 上行。
 * - 重连游标由 client 持有（最近 seq），transport 重连时回调取最新 URL。
 */

export interface WidgetAgentClientOptions {
  /** 后端 origin，如 https://api.host.com。 */
  backendBase: string;
  sessionId: string;
  /**
   * widget 短时 JWT（可选，WS 走 query）；省略=内部普通会话，后端零鉴权不校验。
   * 第三方嵌入时由宿主服务端换取后注入；内部场景可完全不传。
   */
  token?: string | undefined;
  /** 宿主业务工具（hostTools）；握手时 tools.register 上行，delegate_call 时本地执行。 */
  hostTools?: DelegatedToolSpec[];
}

interface HostToolEntry {
  spec: DelegatedToolSpec;
}

export class WidgetAgentClient implements AgentClient {
  private readonly backendBase: string;
  private readonly sessionId: string;
  private readonly token: string | undefined;

  private transport: WidgetWsTransport | null = null;
  private execState = createExecutionTreeState();
  private cursor: number | null = null;

  private readonly statusValue: ObservableValue<ConnectionStatus>;
  private readonly eventsValue: EventStream;
  private readonly treeValue: ObservableValue<ExecutionTree>;
  private readonly runStatusValue: ObservableValue<RunStatus>;
  private readonly pendingValue: ObservableValue<PendingInteraction[]>;

  /** 待决议的 send ack 等待器（widget 单 run 串行，至多一个 pending）。 */
  private pendingSendAck: ((result: { ok: boolean; error?: string }) => void) | null = null;

  private delegationEnabled = false;
  private readonly hostTools = new Map<string, HostToolEntry>();
  private readonly toolCallHandlers = new Set<ToolCallHandler>();

  constructor(options: WidgetAgentClientOptions) {
    this.backendBase = options.backendBase;
    this.sessionId = options.sessionId;
    this.token = options.token;
    this.statusValue = new ObservableValue<ConnectionStatus>({ state: "idle" });
    this.eventsValue = new EventStream();
    this.treeValue = new ObservableValue<ExecutionTree>({ root: null, steps: [] });
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
   * 建立连接。widget 自建 WS URL（backendBase + token + cursor），故忽略契约的 options.url；
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
    this.transport = new WidgetWsTransport({
      initialUrl: this.buildUrl(this.cursor),
      resolveReconnectUrl: () => this.buildUrl(this.cursor),
      sessionId: this.sessionId,
      handlers: {
        onStatus: (status) => {
          this.statusValue.set(status);
          if (status.state === "connected") {
            this.onConnected();
          }
        },
        onEnvelope: (env) => this.handleEnvelope(env),
      },
    });
    this.transport.connect();
  }

  disconnect(): void {
    this.transport?.disconnect();
    this.transport = null;
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
   * runStatus 仅在 ack ok 时转 running。
   */
  async send(options: SendOptions): Promise<SendResult> {
    const requestId = options.requestId ?? generateRequestId();
    // 未连接（连接中/重连中/已断开）：字节发不出去，直接判失败，UI 不切 running。
    if (this.statusValue.get().state !== "connected") {
      return { started: false, requestId, error: "连接未就绪" };
    }
    const ackPromise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      this.pendingSendAck = resolve;
    });
    this.transport?.send(encodeSend(this.sessionId, {
      task: options.task,
      ...(options.selectedLlm ? { selectedLlm: options.selectedLlm } : {}),
      ...(options.attachments ? { attachments: options.attachments } : {}),
      requestId,
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
    if (result.ok) {
      this.runStatusValue.set({ runId: null, state: "running" });
      return { started: true, requestId };
    }
    this.runStatusValue.set({ runId: null, state: "idle" });
    return { started: false, requestId, ...("error" in result && result.error ? { error: result.error } : {}) };
  }

  stop(): void {
    this.transport?.send(encodeStop(this.sessionId));
  }

  async respondInteraction(interactionId: string, response: InteractionResponse): Promise<void> {
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
    // 本地立即移除该 interaction（UI 即时消失），不等后端 responded 回环。
    this.dropPending(interactionId);
  }

  async approve(interactionId: string, approved: boolean, message?: string): Promise<void> {
    await this.respondInteraction(interactionId, { kind: "approval", approved, ...(message ? { message } : {}) });
  }

  async respondInput(interactionId: string, value: string): Promise<void> {
    await this.respondInteraction(interactionId, { kind: "user_input", value });
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

  private buildUrl(cursor: number | null): string {
    return buildWidgetWsUrl({
      backendBase: this.backendBase,
      sessionId: this.sessionId,
      token: this.token,
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
    this.eventsValue.emit(env);
    applyEnvelope(this.execState, env);
    this.treeValue.set(getExecutionTree(this.execState));
    const cursor = extractCursor(env);
    if (cursor !== null) {
      this.cursor = cursor;
    }
    this.updateRunStatus(env);
    this.updatePending(env);
  }

  private handleAck(env: Envelope): void {
    const payload = env.payload as { category?: string; ok?: boolean; error?: string } | undefined;
    if (payload?.category === "send" && this.pendingSendAck) {
      const resolve = this.pendingSendAck;
      this.pendingSendAck = null;
      resolve({ ok: payload.ok ?? false, ...(payload.error ? { error: payload.error } : {}) });
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

  private updateRunStatus(env: Envelope): void {
    if (env.type === "run_started") {
      this.runStatusValue.set({
        runId: typeof env.run_id === "string" ? env.run_id : null,
        state: "running",
      });
    } else if (env.type === "run_ended") {
      const payload = env.payload as { status?: string } | undefined;
      const state = payload?.status === "completed" ? "completed" : payload?.status === "failed" ? "failed" : "interrupted";
      this.runStatusValue.set({
        runId: typeof env.run_id === "string" ? env.run_id : null,
        state,
      });
    }
  }

  private updatePending(env: Envelope): void {
    if (env.type !== "interaction") {
      return;
    }
    const payload = env.payload as {
      phase?: string;
      kind?: string;
      tool?: string;
      prompt?: string;
      risk_level?: string;
      arguments?: unknown;
    } | undefined;
    const callId = typeof env.call_id === "string" ? env.call_id : null;
    if (!callId) {
      return;
    }
    if (payload?.phase === "required") {
      const current = this.pendingValue.get();
      if (!current.some((item) => item.interactionId === callId)) {
        this.pendingValue.set([
          ...current,
          {
            interactionId: callId,
            kind: (payload.kind === "user_input" ? "user_input" : "approval"),
            ...(payload.tool ? { toolName: payload.tool } : {}),
            ...(payload.arguments !== undefined ? { arguments: payload.arguments } : {}),
            ...(payload.risk_level ? { riskLevel: payload.risk_level } : {}),
            ...(payload.prompt ? { prompt: payload.prompt } : {}),
            receivedAt: Date.now(),
          },
        ]);
      }
    } else if (payload?.phase === "responded") {
      this.dropPending(callId);
    }
  }

  private dropPending(interactionId: string): void {
    const next = this.pendingValue.get().filter((item) => item.interactionId !== interactionId);
    if (next.length !== this.pendingValue.get().length) {
      this.pendingValue.set(next);
    }
  }
}

function generateRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
