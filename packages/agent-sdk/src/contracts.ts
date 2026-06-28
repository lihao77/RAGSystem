/**
 * Agent 运行时 SDK 契约层（纯类型 + 端口，零运行时代码）。
 *
 * 这是内核与扩展点（Protocol / ToolProvider / Context / 审批端口）之间唯一的耦合面。
 * 事件 Hook 类型在 hooks/ 下单独定义（事件 hook 与端口契约职责不同，分开导出）。
 * 内核只依赖本文件的类型，绝不 import 任何具体实现。
 *
 * 与 backend-ts kernel/contracts.ts 的差异：
 * - session.agent: AgentConfig → session.profile: AgentProfile（设计稿 §3 投影）
 * - EventSink 透传 KernelEvent，SDK 不翻译成 Envelope（设计稿 §6 原则 1/4：消费端翻译）
 * - 端口词汇去掉 backend-ts 的 runtime-tool-types 依赖，工具执行端口直接收 profile
 */
import type { ChatMessage, LlmRequest } from "@ragsystem/agent-llm";
// 标量事件壳从协议面 import（供本文件 KernelEvent union 引用）+ re-export（供下游使用）。
// 3 个携带 ChatMessage 的事件（intent_complete/assistant_intermediate/observation_complete）在下方 extends 壳扩展。
import type {
  FirstTokenEvent,
  OutputDeltaEvent,
  IntentDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  RuntimeErrorEvent,
  ContextUsageEvent,
  IntentCompleteEvent as IntentCompleteWire,
  AssistantIntermediateEvent as AssistantIntermediateWire,
  ObservationCompleteEvent as ObservationCompleteWire,
} from "@ragsystem/agent-protocol";
export type {
  FirstTokenEvent,
  OutputDeltaEvent,
  IntentDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  RuntimeErrorEvent,
  ContextUsageEvent,
  KernelWireEvent,
  WireTranslationContext,
} from "@ragsystem/agent-protocol";
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
 * 事件契约下沉协议面：标量壳定义在 @ragsystem/agent-protocol（packages/core/src/kernel-events.ts），
 * 本文件 re-export 7 个纯标量事件（first_token/output_delta/intent_delta/tool_call/tool_result/error/context_usage）。
 * 3 个携带 ChatMessage 的事件（intent_complete/assistant_intermediate/observation_complete）在此 extends 标量壳
 * + 补 message 字段——ChatMessage 持久化由 Dispatcher 用本 union 落库，翻译成 Envelope 由协议面纯函数完成
 *（translateKernelEvent 只读壳的标量字段，不读 message）。内核仍 emit 单一 KernelEvent union，Dispatcher 零改。
 *
 * Dispatcher 按类型分流（落 store + 推 handle.events 流）；翻译成 Envelope 是消费端（backend-ts）的事。
 * ========================================================== */

/**
 * intent 完成（完整事件）：在协议面标量壳上扩展 assistantMessage——Dispatcher 据此 addMessage + 关联 step。
 */
export interface IntentCompleteEvent extends IntentCompleteWire {
  assistantMessage?: ChatMessage;
}

/** assistant 中间态（完整事件）：壳上扩展 message——Dispatcher.persistAssistantMessage 据此落库。 */
export interface AssistantIntermediateEvent extends AssistantIntermediateWire {
  message: ChatMessage;
}

/** observation 完成（完整事件）：壳上扩展 messages——Dispatcher.persistObservations 据此落库。 */
export interface ObservationCompleteEvent extends ObservationCompleteWire {
  messages: ChatMessage[];
}

/** 内核事件 union（含 ChatMessage 字段的完整版，内核 emit / Dispatcher 落库用）。 */
export type KernelEvent =
  | FirstTokenEvent
  | OutputDeltaEvent
  | IntentDeltaEvent
  | IntentCompleteEvent
  | AssistantIntermediateEvent
  | ToolCallEvent
  | ToolResultEvent
  | ObservationCompleteEvent
  | RuntimeErrorEvent
  | ContextUsageEvent;

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
  /**
   * 组"模型收到的 LLM 请求"（messages 经协议渲染/注入说明 + tools + model/provider/参数），**不调 LLM**。
   * run 的 invoke 与 preview 共用此步——run 组完发请求，preview 组完即返回，保证"所见即模型所收"。
   */
  buildRequest(ctx: KernelContext): LlmRequest;
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

/** 工具执行上下文（运行时元数据 + 工具生命周期所需的 caller/workspaceRoot）。 */
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
  /** 调用者来源（direct / code_execution / ...）。 */
  caller?: string;
  /** 当前 agent 名称。 */
  currentAgentName?: string | null;
  /** 工作空间根路径（文件类工具判断外部路径用）。 */
  workspaceRoot?: string | null;
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
 * 工具执行端口（已退役——由 ToolRegistry + Tool 替代）。
 *
 * 保留类型定义仅供消费端过渡期引用（backend-ts SdkToolExecutor 等尚未迁移的适配器）。
 * SDK 内部不再使用；createRuntime 接收 ToolRegistry | Tool[]。
 *
 * @deprecated 使用 Tool + ToolRegistry（from tools/tool.ts + tools/registry.ts）替代。
 */
export interface ToolExecutor {
  listTools(): import("./prompt/tool-types.js").RuntimeToolDefinition[];
  executeTool(call: ToolExecutorCall, ctx: ToolExecContext): ToolExecutionResult | Promise<ToolExecutionResult>;
  classifyConcurrency?(call: ToolExecutorCall, ctx: ToolExecContext): boolean;
  waitForToolResult?(request: ToolWaitRequest, ctx: ToolExecContext): ToolWaitResult | Promise<ToolWaitResult>;
  getToolRiskLevel?(toolName: string): string | undefined;
}

/** 实时输出导线（穿过 Protocol/Tool 内部），零翻译透传 KernelEvent 给 Dispatcher。 */
export interface EventSink {
  emit(event: KernelEvent): void;
}

/** 消息增量补充端口：循环②步补后台通知 + followup。 */
export interface MessageRefresher {
  refresh(ctx: KernelContext): Promise<ChatMessage[]>;
}

/* ============================================================
 * 五、KernelContext（前向声明；实现在 kernel-context.ts）
 * ========================================================== */

// KernelContext 定义在 kernel-context.ts；在此 re-export，使 contracts.ts 成为类型统一出口。
export type { KernelContext } from "./kernel-context.js";

/* ============================================================
 * 六、RuntimeSession —— 一次 run 的输入（对齐设计稿 §2 run() 入参）
 *
 * 去掉 backend-ts 的 onEvent / conversationUpdateProvider 回调——改注入 EventSink /
 * MessageRefresher / 事件 Hook。conversation 只读初始快照；KernelContext 持其浅拷贝作可变工作副本。
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
  /** run 的 agent 名（投影后内联，落 runs.agent_name）。 */
  agentName?: string | null;
  /** run 入口标识（executionKind），落 runs.entrypoint。 */
  entrypoint?: string | null;
  /** run 任务摘要（task 前 200 字），落 runs.task_summary。 */
  taskSummary?: string | null;
  /** run 发起用户，落 runs.user_id。 */
  userId?: string | null;
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
