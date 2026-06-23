/**
 * 最小 MockAgentSDK —— implements AgentSDK，内存事件总线，无真实 WS。
 *
 * 仅用于 demo 验证「协议契约 + 投影骨架 + 委托回调装配」的接入闭环；
 * 非闭环方法做空实现。core 包本身不含 mock（保持纯净）。
 */
import {
  applyEnvelope,
  createExecutionTreeState,
  getExecutionTree,
  type AgentSDK,
  type ConnectionStatus,
  type ConnectOptions,
  type DelegatedToolSpec,
  type Envelope,
  type ExecutionTree,
  type ExecutionTreeState,
  type InteractionResponse,
  type Observable,
  type PendingInteraction,
  type RunStatus,
  type SendOptions,
  type SendResult,
  type ToolCallHandler,
  type ToolCallPayload,
  type ToolPresentationSpec,
  type ToolResult,
  type Unsubscribe,
} from "@ragsystem/agent-sdk-core";

/** 极简可观察容器：持值 + 订阅通知。 */
class Box<T> implements Observable<T> {
  private value: T;
  private readonly listeners = new Set<(v: T) => void>();
  constructor(initial: T) {
    this.value = initial;
  }
  get(): T {
    return this.value;
  }
  set(v: T): void {
    this.value = v;
    for (const l of this.listeners) l(v);
  }
  subscribe(listener: (v: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const PLACEHOLDER_ENVELOPE: Envelope = { type: "heartbeat", session_id: "mock" };

export class MockAgentSDK implements AgentSDK {
  private readonly treeState: ExecutionTreeState = createExecutionTreeState();
  private readonly tools = new Map<string, DelegatedToolSpec>();
  private toolHandler: ToolCallHandler | null = null;
  private delegationEnabled = false;

  readonly status = new Box<ConnectionStatus>({ state: "idle" });
  readonly events = new Box<Envelope>(PLACEHOLDER_ENVELOPE);
  readonly executionTree = new Box<ExecutionTree>({ root: null, steps: [] });
  readonly runStatus = new Box<RunStatus>({ runId: null, state: "idle" });
  readonly pendingInteractions = new Box<PendingInteraction[]>([]);

  /* ---- 连接与生命周期 ---- */

  async connect(_options: ConnectOptions): Promise<void> {
    this.status.set({ state: "connected", sessionId: "mock", lastEventSeq: null });
  }
  disconnect(): void {
    this.status.set({ state: "idle" });
  }

  /* ---- 投影 / 展示 ---- */

  registerToolPresentation(_spec: ToolPresentationSpec): Unsubscribe {
    return () => {};
  }

  /* ---- 用户交互与会话控制 ---- */

  async send(_options: SendOptions): Promise<SendResult> {
    return { started: true };
  }
  stop(): void {}
  async respondInteraction(_interactionId: string, _response: InteractionResponse): Promise<void> {}
  async approve(_interactionId: string, _approved: boolean, _message?: string): Promise<void> {}
  async respondInput(_interactionId: string, _value: string): Promise<void> {}

  /* ---- 委托模式 ---- */

  enableDelegation(): void {
    this.delegationEnabled = true;
  }
  registerTool(spec: DelegatedToolSpec): Unsubscribe {
    this.tools.set(spec.name, spec);
    return () => {
      this.tools.delete(spec.name);
    };
  }
  onToolCall(handler: ToolCallHandler): Unsubscribe {
    this.toolHandler = handler;
    return () => {
      this.toolHandler = null;
    };
  }
  cancelToolCall(_callId: string, _reason?: string): void {}

  /* ---- 逃生舱 ---- */

  sendRaw(_message: Record<string, unknown>): void {}

  /* ---- demo 专用：模拟收到一条后端 envelope ---- */

  feedMock(env: Envelope): void {
    applyEnvelope(this.treeState, env);
    this.events.set(env);
    this.executionTree.set(getExecutionTree(this.treeState));

    // 委托模式：tool_call(delegation, request) 触发宿主 handler
    if (env.type === "tool_call" && this.delegationEnabled && this.toolHandler) {
      const payload = (env.payload ?? {}) as Partial<ToolCallPayload>;
      if (payload.mode === "delegation" && payload.phase === "request") {
        const handler = this.toolHandler;
        void handler({
          callId: env.call_id ?? "",
          toolName: payload.tool ?? "",
          arguments: payload.input,
          runId: env.run_id ?? null,
        }).then((result: ToolResult) => {
          console.log(
            `  -> delegated tool_result: ok=${result.ok} observation="${result.observation}"`,
          );
        });
      }
    }
  }
}
