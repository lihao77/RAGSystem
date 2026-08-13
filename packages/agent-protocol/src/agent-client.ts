/**
 * AgentClient 公开契约（协议契约层）。
 *
 * 本文件仅定义「宿主接入」的公开类型契约，不含任何实现逻辑：
 * - 实现侧（adapter）负责满足此形状；现有 runtime 实现「贴上契约」是后续步骤。
 * - 协议契约以本包 protocol.ts（步骤三 envelope）为准；事件流类型为 Envelope。
 *
 * 两条模式物理分节，职责零交叉（设计红线，禁止合并为单一 onToolCall）：
 *   • 投影模式（Projection）：后端全权执行工具，SDK 单向消费协议 Envelope，
 *     产出只读执行树 / 运行状态 / 待响应交互。后端协议已存在 → 全部「已对接」。
 *   • 委托模式（Delegation）：后端将工具调用委托宿主执行，宿主回传 tool_result。
 *     后端协议当前不存在 → 全部「预留」，未 enableDelegation() 前调用抛 DelegationError。
 *
 * 方法标注约定：
 *   @mode    projection | delegation | common
 *   @status  wired（已对接现有协议）| reserved（预留，当前后端无协议）
 *
 * @see 盘点报告 第一节（通信通道）、第二节（工具调用链路）、第四节（abort 机制）
 */

import type {
  AssistantContentPart,
  ToolFileRef,
  Envelope,
  InteractionKind,
  AttachmentRef,
  SessionRuntimePayload,
  SessionRuntimeState,
} from "./protocol.js";

/* ============================================================
 * 一、基础抽象（最小订阅语义，不绑定任何响应式框架）
 * ========================================================== */

/** 取消订阅句柄。 */
export type Unsubscribe = () => void;

/**
 * 本包最小可观察抽象。
 * 各 adapter（Vue composable / React hook / Svelte store）负责把它转成各自的响应式形态；
 * agent-protocol 自身保持纯回调，不依赖任何响应式运行时。
 */
export interface Observable<T> {
  /** 当前快照（订阅前立即可取值，非 reactive 宿主也能用）。 */
  get(): T;
  /** 订阅后续变化，返回取消订阅句柄。 */
  subscribe(listener: (value: T) => void): Unsubscribe;
}

/**
 * 连接状态机。
 * 来源：WS readyState + reconnect_start / reconnect_end 帧（routes/agent/ws.ts）。
 */
export type ConnectionStatus =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "connected"; sessionId: string; lastEventSeq: number | null }
  | { state: "reconnecting"; replayCount: number }
  | { state: "disconnected"; reason?: string };

/* ============================================================
 * 二、连接与生命周期（common · wired）
 * ========================================================== */

/** 重连退避策略。本包提供默认值（指数退避），宿主可覆盖。 */
export interface ReconnectPolicy {
  enabled: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** 传输适配抽象。本包不直接依赖 ws 库；adapter 注入原生 WebSocket 或测试 mock。 */
export interface WebSocketTransport {
  open(url: string): WebSocketLike;
}

/** 本包声明的传输句柄形状，对齐浏览器 WebSocket / ws 包的子集。 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen?: () => void;
  onmessage?: (data: string) => void;
  onclose?: (ev: { code: number; reason: string }) => void;
  onerror?: (error: unknown) => void;
}

/** connect 入参。 */
export interface ConnectOptions {
  /**
   * WS URL，形如 ws://host/api/agent/sessions/:sessionId/ws。
   * session_id 是连接的 URL 绑定（routes/agent/ws.ts），故 connect 前必须已知；
   * session 经 POST /api/agent/sessions 创建或复用，由宿主自行取得 id。
   */
  url: string;
  /**
   * 断线重连游标，对应 ?after_seq（ws.ts durable outbox 重放边界）。
   * 不传则首次连接按后端默认重放当前 active run。
   */
  afterEventSeq?: number;
  /** 传输适配器；adapter 注入。 */
  transport?: WebSocketTransport;
  /** 重连退避策略；不传用本包默认。 */
  reconnect?: ReconnectPolicy;
}

/* ============================================================
 * 三、投影模式：状态视图类型（projection · wired）
 * ========================================================== */

/** 当前 run 展示状态；只由 session.runtime 的 active_run / last_run 派生。 */
export interface RunStatus {
  runId: string | null;
  state: SessionRuntimeState | "completed" | "failed" | "interrupted";
  startedAt?: string;
  finishedAt?: string;
}

/**
 * 待宿主响应的交互（审批 / 用户输入）。
 * 来源：session.runtime.pending_interactions；原始 interaction 帧不拥有 UI 生命周期。
 */
export interface PendingInteraction {
  interactionId: string;
  kind: InteractionKind; // "approval" | "user_input"
  status: "waiting" | "suspended";
  runId: string;
  rootRunId: string;
  batchId: string;
  toolName?: string;
  arguments?: unknown;
  riskLevel?: string;
  prompt?: string;
  receivedAt: number;
}

/** 单次工具调用（tool_call + tool_result 按 call_id 配对后的视图）。 */
export interface ExecutionToolCall {
  callId: string;
  toolName: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  arguments?: unknown;
  observation?: string;
  summary?: string;
  files?: ToolFileRef[];
  rawResultRef?: string;
  approval?: { status: "pending" | "granted" | "denied" };
  elapsedMs?: number;
  agentOperation?: import("./protocol.js").AgentOperation;
}

/** ReAct 单轮：一段 intent（思考文本）+ 该轮发起的工具调用。 */
export interface ExecutionRound {
  round: number;
  intent: string;
  intentComplete: boolean;
  toolCalls: ExecutionToolCall[];
}

export interface ExecutionAgentMessage {
  messageId: string;
  kind: "progress" | "request" | "response" | "result";
  content: string;
  sourceRunId?: string | null;
  sourceAgentCallId?: string | null;
  correlationId?: string | null;
  replyToMessageId?: string | null;
  metadata?: Record<string, unknown>;
  receivedAt: number;
}

/**
 * 执行体（一个 agent 的 ReAct 轮次集合；可嵌套子 agent）。
 * root agent（orchestrator）的 rounds 即主对话执行步骤；children 为子 agent 任务树。
 * round/order 不进协议顶层，由本包据 ReAct 结构（intent→tools→observation→intent）推断。
 */
export interface ExecutionAgent {
  agentId: string;
  callId: string;
  /** 触发本次子 agent 执行的 agent 工具 call_id。 */
  invocationCallId?: string;
  /** Session participant id for opening the child thread. */
  participantId?: string;
  displayName?: string;
  /** agent 流式输出（stream_output delta/final 累加）；子 agent 实时展示用，result 为终态。 */
  output?: string;
  outputParts?: AssistantContentPart[];
  task?: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  result?: string;
  rounds: ExecutionRound[];
  children: ExecutionAgent[];
  messages?: ExecutionAgentMessage[];
  parentCallId?: string;
}

/** SDK 消费事件流后产出的执行树投影（消费 tool_call/tool_result/stream_output/agent_started/agent_ended）。 */
export interface ExecutionTree {
  /** root 执行体（orchestrator agent）；无事件时为 null。 */
  root: ExecutionAgent | null;
  /** 扁平原始帧流，保留顺序（供调试 / 自定义渲染）。 */
  steps: Envelope[];
}

/**
 * 工具展示元数据（projection · wired，adapter 自管）。
 * 纯展示，无执行语义。SDK 仅做 tool_name → 元数据查表透传；不进后端协议。
 * 用途：替代前端 toolPresentation.js 的硬编码 if 分支。
 */
export interface ToolPresentationSpec {
  toolName: string;
  displayName?: string;
  icon?: string;
  renderHint?:
    | "default"
    | "file"
    | "visualization"
    | "agent"
    | "skill"
    | "memory"
    | "code";
}

/* ============================================================
 * 四、用户交互：请求 / 响应类型（common · wired）
 * ========================================================== */

/** send 入参，对齐 ClientToServerMessage 的 send 分支（contracts/events.ts）。 */
export interface SendOptions {
  task: string;
  userId?: string;
  selectedLlm?: string;
  attachments?: AttachmentRef[];
  /** 幂等键，对齐 send.request_id。 */
  requestId?: string;
  /** 前端组件状态快照(对齐 events.ts task_submit 的 ui_context);widget 采集宿主状态用。 */
  uiContext?: Record<string, unknown>;
}

/** send 结果，对齐 AgentRunStartResult（contracts/execution.ts）。 */
export interface SendResult {
  started: boolean;
  /** 后端接受的执行类型；command 不一定产生标准 run 事件。 */
  kind?: "agent_run" | "command";
  runId?: string;
  requestId?: string;
  error?: string;
}

/**
 * 统一交互响应，对齐 InteractionResponsePayload（contracts/interactions.ts）。
 * SDK 内部发 { type: "interaction.respond" }，不使用 legacy approve / user_input 旧路径。
 */
export interface InteractionResponse {
  kind?: InteractionKind;
  /** kind=approval 时必填。 */
  approved?: boolean;
  /** kind=user_input 时必填。 */
  value?: string;
  message?: string;
}

/* ============================================================
 * 五、委托模式：类型（delegation · reserved：后端当前无对应协议）
 * ========================================================== */

/** 委托执行上下文，由 SDK 注入工具 execute()。 */
export interface DelegationContext {
  callId: string;
  /** abort 信号：后端 stop 或 cancelToolCall 时触发。
   *  补齐盘点报告第四节缺口（前端宿主当前无本地 AbortSignal 可注入工具）。 */
  signal: AbortSignal;
  sessionId: string;
  runId: string | null;
}

/** 工具执行结果。observation 将作为 tool_result 内容回填 LLM（对齐 MessageInfo tool 消息形态）。 */
export interface ToolResult {
  ok: boolean;
  observation: string;
  structured?: unknown;
  error?: string;
  elapsedMs?: number;
}

/**
 * 宿主可执行业务工具的能力声明（reserved）。
 * —— 这是「执行能力」，不是展示配置；展示走第三节 ToolPresentationSpec。
 */
export interface DelegatedToolSpec {
  name: string;
  description: string;
  /** JSON Schema 参数描述，与后端 RuntimeTool 的 tool schema 对齐。 */
  inputSchema: Record<string, unknown>;
  /** 执行函数；返回结果由 SDK 自动包装成协议消息回传（见 AgentClient.onToolCall）。 */
  execute(input: unknown, ctx: DelegationContext): Promise<ToolResult>;
  riskLevel?: "low" | "medium" | "high";
  cancellable?: boolean;
}

/**
 * 宿主工具声明（bridge 中立子集）：DelegatedToolSpec 去掉 execute 的 ctx。
 * - execute 无 DelegationContext（iframe bridge 转发场景传不了完整 ctx），返回 ToolResult。
 * - 同一份定义两用：主网页直接注册给 widget / 嵌入网页经 iframe bridge 传递（serve 声明）。
 * - 前端工具 MCP 执行端（widget RagMcpClient）上报工具元数据也复用此形态。
 */
export interface HostToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel?: "low" | "medium" | "high";
  execute: (input: unknown) => Promise<ToolResult>;
}

/**
 * widget 元素的最小注册接口（结构兼容 RagWidgetHandle，避免 bridge 反向依赖 widget 包）。
 * bridge 转发场景：execute = (input) => bridge.call(name, input)。
 */
export interface HostToolRegistrar {
  registerHostTool: (spec: HostToolDeclaration) => () => void;
  unregisterHostTool?: (name: string) => void;
}

/** 后端委托的工具调用请求（reserved）。 */
export interface ToolCallRequest {
  callId: string;
  toolName: string;
  arguments: unknown;
  runId: string | null;
}

/** onToolCall 处理器。返回结果即回传（自动包装，无需手动 send）。 */
export type ToolCallHandler = (request: ToolCallRequest) => Promise<ToolResult>;

/** 未 enableDelegation() 时调用委托模式方法所抛错误的类型形状。 */
export interface DelegationError extends Error {
  readonly code: "DELEGATION_DISABLED";
}

/* ============================================================
 * 六、AgentClient 公开契约
 * ========================================================== */

/**
 * 宿主接入 Agent 运行时的公开门面契约。
 * 实现侧以 `class XxxAgentClient implements AgentClient` 满足；消费者依赖此形状。
 */
export interface AgentClient {
  /* ---- 连接与生命周期（common · wired）---- */

  /** 建立连接。幂等：已连接时直接 resolve 当前连接。 @mode common @status wired */
  connect(options: ConnectOptions): Promise<void>;
  /** 主动断开，清理订阅 / 心跳。不取消后端 run（如需停止请先 stop()）。 @mode common @status wired */
  disconnect(): void;
  /** 连接状态可观察对象。 @mode common @status wired */
  readonly status: Observable<ConnectionStatus>;

  /* ---- 投影模式：事件与状态（projection · wired）---- */

  /** 原始事件流（去重、cursor 校准后透传 Envelope）。 @mode projection @status wired */
  readonly events: Observable<Envelope>;
  /** 结构化执行树投影（SDK 消费执行类 Envelope 后产出）。 @mode projection @status wired */
  readonly executionTree: Observable<ExecutionTree>;
  /** Session 生命周期权威快照；所有加载策略与动作权限只读此对象。 @mode projection @status wired */
  readonly runtime: Observable<SessionRuntimePayload>;
  /** 当前 run 展示状态，由 runtime.active_run/last_run 派生，不消费 run/ACK 猜测。 @mode projection @status wired */
  readonly runStatus: Observable<RunStatus>;
  /** 待响应交互列表，由 runtime.pending_interactions 派生。 @mode projection @status wired */
  readonly pendingInteractions: Observable<PendingInteraction[]>;

  /* ---- 投影模式：展示配置（projection · wired，adapter 自管）---- */

  /** 注册工具展示元数据。返回注销句柄。 @mode projection @status wired */
  registerToolPresentation(spec: ToolPresentationSpec): Unsubscribe;

  /* ---- 用户交互与会话控制（common · wired）---- */

  /** 发起一个 run，内部发 { type: "send" }。 @mode common @status wired */
  send(options: SendOptions): Promise<SendResult>;
  /** 停止当前 session 活跃 run，内部发 { type: "stop" }。fire-and-forget：终态由 runStatus 观察，
   *  非本地中断（盘点报告第四节：前端无本地 AbortController）。 @mode common @status wired */
  stop(): void;
  /** 统一交互响应，内部发 { type: "interaction.respond" }（收口 legacy 双发）。 @mode common @status wired */
  respondInteraction(interactionId: string, response: InteractionResponse): Promise<void>;
  /** 审批便捷方法 = respondInteraction(id, { kind:"approval", approved, message })。 @mode common @status wired */
  approve(interactionId: string, approved: boolean, message?: string): Promise<void>;
  /** 用户输入便捷方法 = respondInteraction(id, { kind:"user_input", value })。 @mode common @status wired */
  respondInput(interactionId: string, value: string): Promise<void>;
  /** 恢复已持久化且已完成响应的 suspended run。interaction id 由 runtime 指定。 */
  resume(): Promise<boolean>;

  /* ---- 委托模式（delegation · reserved：后端当前无协议）---- */

  /** 显式开启委托模式。未开启时本组方法全部禁用。 @mode delegation @status reserved */
  enableDelegation(): void;
  /** 注册一个宿主业务工具。返回注销句柄。 @mode delegation @status reserved */
  registerTool(spec: DelegatedToolSpec): Unsubscribe;
  /** 监听后端委托的 tool_call。返回注销句柄。 @mode delegation @status reserved */
  onToolCall(handler: ToolCallHandler): Unsubscribe;
  /** 宿主主动取消进行中的工具调用（触发 DelegationContext.signal.abort）。 @mode delegation @status reserved */
  cancelToolCall(callId: string, reason?: string): void;

  /* ---- 逃生舱（common · reserved）---- */

  /** 直接发任意 ClientToServer 消息，用于协议未覆盖的降级 / 调试。 @mode common @status reserved */
  sendRaw(message: Record<string, unknown>): void;
}
