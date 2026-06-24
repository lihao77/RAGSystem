/**
 * Agent 运行时 SDK 契约层（纯类型 + 端口，零运行时代码）。
 *
 * 这是内核与扩展点（Protocol / ToolProvider / Context / HookRegistry）之间唯一的耦合面。
 * 内核只依赖本文件的类型，绝不 import 任何具体实现。
 *
 * 与 backend-ts kernel/contracts.ts 的差异：
 * - session.agent: AgentConfig → session.profile: AgentProfile（设计稿 §3 投影）
 * - EventSink 透传 KernelEvent，SDK 不翻译成 Envelope（设计稿 §6 原则 1/4：消费端翻译）
 * - 端口词汇去掉 backend-ts 的 runtime-tool-types 依赖，工具执行端口直接收 profile
 */
import type { ChatMessage } from "@ragsystem/agent-llm";
import type {
  AgentProfile,
  ToolCallRef,
  MessageInfo,
  RunStepRecord,
  RunRecord,
  RunStatus,
} from "./types.js";
// KernelContext 定义在 kernel-context.ts；contracts 的端口方法签名直接引用其类型，
// 故本地 import（不止 re-export）。kernel-context 反向 import 本文件的 RuntimeSession 等，构成单向环。
import type { KernelContext } from "./kernel-context.js";

/* ============================================================
 * 一、KernelEvent —— 内核产出的运行时语义事件（透传，不翻译）
 *
 * Dispatcher 按类型分流（落 store + 推 handle.events 流），翻译成 Envelope 或其它可视化形态
 * 是消费端（backend-ts）的事。内核只 emit 这些语义完整的事件。
 * ========================================================== */

export interface FirstTokenEvent {
  type: "first_token";
  agentName: string;
  elapsedMs: number;
}

export interface OutputDeltaEvent {
  type: "output_delta";
  agentName: string;
  content: string;
}

export interface IntentDeltaEvent {
  type: "intent_delta";
  agentName: string;
  content: string;
  round: number;
}

export interface IntentCompleteEvent {
  type: "intent_complete";
  agentName: string;
  content: string;
  round: number;
  /** intent 落库的 assistant 消息（Dispatcher 据此 addMessage + 关联 step）。 */
  assistantMessage?: ChatMessage;
}

export interface AssistantIntermediateEvent {
  type: "assistant_intermediate";
  agentName: string;
  round: number;
  message: ChatMessage;
}

export interface ToolCallEvent {
  type: "tool_call";
  agentName: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  round: number;
  order: number;
  roundIndex: number;
}

export interface ToolResultEvent {
  type: "tool_result";
  agentName: string;
  toolCallId: string;
  toolName: string;
  success: boolean;
  summary: string;
  observation: string;
  metadata: Record<string, unknown>;
  elapsedTime: number;
  round: number;
  order: number;
  roundIndex: number;
}

export interface ObservationCompleteEvent {
  type: "observation_complete";
  agentName: string;
  round: number;
  /** observation 落库的结构化 role:tool 消息（Dispatcher 据此 addMessage）。 */
  messages: ChatMessage[];
}

export interface RuntimeErrorEvent {
  type: "error";
  agentName: string;
  message: string;
}

/** 内核事件（运行时语义，透传给 Dispatcher）。 */
export type KernelEvent =
  | FirstTokenEvent
  | OutputDeltaEvent
  | IntentDeltaEvent
  | IntentCompleteEvent
  | AssistantIntermediateEvent
  | ToolCallEvent
  | ToolResultEvent
  | ObservationCompleteEvent
  | RuntimeErrorEvent;

/** 内核事件处理器（EventSink 透传用）。 */
export type KernelEventHandler = (event: KernelEvent) => void | Promise<void>;

/* ============================================================
 * 二、内核循环的零件类型
 * ========================================================== */

/** 单轮工具调用申请（Protocol 向内核提交，执行权在内核）。 */
export interface PreparedRoundToolCall {
  index: number;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/** 工具调用 = PreparedRoundToolCall（语义别名）。 */
export type KernelToolCall = PreparedRoundToolCall;

/** observation 落盘产物（大 payload 物化成文件后的引用）。 */
export interface ToolArtifact {
  artifactType: "json" | "text";
  path: string;
  mimeType: string;
  size: number;
  metadata: Record<string, unknown>;
}

/** 工具执行结果（对齐 backend-ts ToolExecutionResult 形状）。 */
export interface ToolExecutionResult {
  success: boolean;
  toolName: string;
  summary: string;
  answer: string | null;
  outputType: string;
  content: unknown;
  metadata: Record<string, unknown>;
  artifacts: ToolArtifact[];
  llmHint: string | null;
}

/** 单轮工具观测结果（内核执行 ToolProvider 后回填给 Protocol）。 */
export interface KernelObservation {
  index: number;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: ToolExecutionResult;
  observation: string;
}

/** 一次 invoke 的产物：最终回答 or 工具调用申请。 */
export type KernelOutcome =
  | { kind: "final"; finalAnswer: string; assistantMessage: ChatMessage; finishReason: string | null }
  | { kind: "tool_calls"; calls: KernelToolCall[]; assistantMessage: ChatMessage; finishReason: string | null };

/** run 最终结果（metadata 源自 profile/provider，对齐 backend-ts KernelResult 形状）。 */
export interface KernelResult {
  content: string;
  raw?: unknown;
  finishReason: string | null;
  metadata: {
    agentName: string;
    providerKey: string | null;
    providerType: string;
    modelName: string;
  };
}

/* ============================================================
 * 三、内核三只手（端口）
 * ========================================================== */

/**
 * 工具指令形态：决定 Context 注入哪种协议说明。
 * - "xml"：注入完整 XML 协议说明，XmlProtocol 从文本解析工具调用。
 * - "native"：仅 <intent>/<final_answer>，工具走厂商 function calling。
 */
export type ToolInstructionMode = "xml" | "native";

/** 上下文构建端口：把会话累积组装成发给模型的消息（system prompt + 会话渲染 + 协议说明）。 */
export interface Context {
  buildMessages(ctx: KernelContext): ChatMessage[];
}

/**
 * 问模型 + 解析 + 发 delta 的协议端口。invoke 自包请求壳（model/provider/temperature/signal），
 * 读 ctx.requestMessages 作下发 messages；内部完成边流边解析 + 修复重试。
 */
export interface Protocol {
  invoke(ctx: KernelContext, round: number): Promise<KernelOutcome>;
  renderObservations(calls: KernelToolCall[], observations: KernelObservation[]): ChatMessage[];
  toModelMessages(messages: ChatMessage[]): ChatMessage[];
}

/** 工具执行端口。executeRound 内部 emit tool_call/tool_result（经 EventSink）。 */
export interface ToolProvider {
  executeRound(ctx: KernelContext, round: number, calls: KernelToolCall[]): Promise<KernelObservation[]>;
}

/** 工具执行调用（消费端 ToolExecutor 收到的单次调用）。 */
export interface ToolExecutorCall {
  toolName: string;
  arguments: Record<string, unknown>;
  callId: string;
}

/** 工具执行上下文（透传运行时元数据给消费端）。 */
export interface ToolExecContext {
  sessionId: string | null;
  runId: string | null;
  taskId: string | null;
  requestId: string | null;
  parentCallId: string | null;
  toolCallId: string | null;
  round: number | null;
  order: number | null;
  roundIndex: number | null;
  signal?: AbortSignal;
}

/** 后台任务等待请求。 */
export interface ToolWaitRequest {
  backgroundTaskId: string;
  timeoutMs?: number | null;
}

/** 后台任务等待结果。 */
export interface ToolWaitResult {
  success: boolean;
  timeout: boolean;
  payloads: Array<Record<string, unknown>>;
}

/**
 * 工具执行端口（消费端实现）：负责"工具实际跑什么 + 产出原始 ToolExecutionResult"。
 * SDK 的 RuntimeToolProvider 负责编排（依赖分批、并发调度、abort、{result_N} 引用解析、
 * observation 渲染落盘）后调用它。
 */
export interface ToolExecutor {
  listTools(): import("./prompt/tool-types.js").RuntimeToolDefinition[];
  executeTool(call: ToolExecutorCall, ctx: ToolExecContext): ToolExecutionResult | Promise<ToolExecutionResult>;
  classifyConcurrency?(call: ToolExecutorCall, ctx: ToolExecContext): boolean;
  waitForToolResult?(request: ToolWaitRequest, ctx: ToolExecContext): ToolWaitResult | Promise<ToolWaitResult>;
}

/** 实时输出导线（穿过 Protocol/Tool 内部），零翻译透传 KernelEvent 给 Dispatcher。 */
export interface EventSink {
  emit(event: KernelEvent): void;
}

/** 消息增量补充端口：循环②步补后台通知 + followup。 */
export interface MessageRefresher {
  refresh(ctx: KernelContext): Promise<ChatMessage[]>;
}

/** 钩子点：beforeModel（轮首问模型前）；afterModel（问模型返回后，刷 stable-prefix 缓存）。 */
export type HookPoint = "beforeModel" | "afterModel";

/** 钩子注册表：invoke 顺序 await 执行该 point 下所有 fn。 */
export interface HookRegistry {
  invoke(point: HookPoint, ctx: KernelContext, round?: number): Promise<void>;
  register(point: HookPoint, fn: (ctx: KernelContext, round?: number) => void | Promise<void>): void;
}

/* ============================================================
 * 四、KernelContext（前向声明；实现在 kernel-context.ts）
 * ========================================================== */

// KernelContext 定义在 kernel-context.ts；在此 re-export，使 contracts.ts 成为类型统一出口。
export type { KernelContext } from "./kernel-context.js";

/* ============================================================
 * 五、RuntimeSession —— 一次 run 的输入（对齐设计稿 §2 run() 入参）
 *
 * 去掉 backend-ts 的 onEvent / conversationUpdateProvider 回调——改注入 EventSink /
 * MessageRefresher / Hook。conversation 只读初始快照；KernelContext 持其浅拷贝作可变工作副本。
 * ========================================================== */

export interface RuntimeSession {
  profile: AgentProfile;
  /** tiers.default 的 provider（= 顶层 provider，设计稿 §3：单一真相）。 */
  provider: AgentProfile["llmTiers"][string]["provider"];
  modelName: string;
  conversation: ChatMessage[];
  signal?: AbortSignal;
  sessionId: string;
  runId: string;
  taskId: string | null;
  requestId: string | null;
  rootCallId: string | null;
  threadKey: string;
  parentCallId: string | null;
}

/** 运行时 store 端口（设计稿 §5：内核读历史 / 落 step+message 的事务边界）。 */
export interface RuntimeStore {
  runInTransaction<T>(fn: (tx: RuntimeTx) => T): T;
  /** 关闭底层资源（如 sqlite 句柄）；无资源的实现可不提供。 */
  close?(): void;
  listMessages(sessionId: string, threadKey?: string, limit?: number): MessageInfo[];
  getMessageById(sessionId: string, messageId: string): MessageInfo | null;
  createRun(input: CreateRunInput): void;
  getRun(runId: string): RunRecord | null;
  updateRunStatus(runId: string, status: RunStatus, finalMessageId?: string): boolean;
}

export interface CreateRunInput {
  id: string;
  sessionId: string;
  rootCallId: string;
  threadKey: string;
  parentCallId: string | null;
}

export interface RuntimeTx {
  addMessage(input: AddMessageInput): MessageInfo;
  addRunStep(input: AddRunStepInput): RunStepRecord;
  updateRunStepsMessageId(sessionId: string, runId: string, messageId: string): number;
  insertCompressionMessage(input: InsertCompressionMessageInput): MessageInfo;
}

export interface AddMessageInput {
  sessionId: string;
  role: MessageInfo["role"];
  content: string;
  metadata?: Record<string, unknown>;
  toolCalls?: ToolCallRef[];
  toolCallId?: string;
  name?: string;
  threadKey?: string;
  childAgentId?: string | null;
  messageId?: string;
}

export interface AddRunStepInput {
  sessionId: string;
  runId: string;
  stepType: string;
  payload: Record<string, unknown>;
  messageId?: string | null;
}

export interface InsertCompressionMessageInput {
  sessionId: string;
  threadKey?: string;
  content: string;
  metadata?: Record<string, unknown>;
  replacesUpToSeq?: number;
}
