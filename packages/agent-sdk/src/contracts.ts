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
import type { ChatMessage, LlmRequest, TokenUsage } from "@ragsystem/agent-llm";
// 标量事件壳从协议面 import（供本文件 KernelEvent union 引用）+ re-export（供下游使用）。
// 2 个携带 ChatMessage 的事件（intent_complete/assistant_intermediate）在下方 extends 壳扩展。
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
 * 2 个携带 ChatMessage 的事件（intent_complete/assistant_intermediate）在此 extends 标量壳
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

/** 内核事件 union（含 ChatMessage 字段的完整版，内核 emit / Dispatcher 落库用）。 */
export type KernelEvent =
  | FirstTokenEvent
  | OutputDeltaEvent
  | IntentDeltaEvent
  | IntentCompleteEvent
  | AssistantIntermediateEvent
  | ToolCallEvent
  | ToolResultEvent
  | RuntimeErrorEvent
  | ContextUsageEvent;

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
  artifactType: "json" | "text" | "image";
  path: string;
  mimeType: string;
  size: number;
  metadata: Record<string, unknown>;
}

/** Binary media returned by a tool before the observation layer materializes it. */
export interface ToolResultMedia {
  kind: "image";
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  source: { type: "base64"; data: string } | { type: "file"; path: string } | { type: "url"; url: string };
  alt?: string;
  detail?: "auto" | "low" | "high";
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
  media?: ToolResultMedia[];
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
  /** Model-only multimodal projection. Events and persistence continue to use observation text. */
  modelContent?: ChatMessage["content"];
}

/** 一次 invoke 的产物：最终回答 or 工具调用申请。两分支都携带本轮 LLM 返回的 token 用量槽位（provider 未返回时为 undefined）。 */
export type KernelOutcome =
  | { kind: "final"; finalAnswer: string; assistantMessage: ChatMessage; finishReason: string | null; usage: TokenUsage | undefined }
  | { kind: "tool_calls"; calls: KernelToolCall[]; assistantMessage: ChatMessage; finishReason: string | null; usage: TokenUsage | undefined };

/** run 最终结果（metadata 源自 profile/provider，对齐 backend-ts KernelResult 形状）。usage 为本轮循环累计 token 用量。 */
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
  /** 整个 run 各轮 LLM 调用的累计 token 用量；无 provider 返回时为 undefined。 */
  usage?: TokenUsage;
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

/** 工具执行上下文（运行时元数据 + 工具生命周期所需的 caller/workspaceRoot）。 */
export interface ToolExecContext {
  sessionId: string | null;
  runId: string | null;
  /** Root invocation call id shared by the execution tree for durable interactions. */
  rootCallId?: string | null;
  /** Current run's invocation call id; root run equals rootCallId. */
  currentCallId?: string | null;
  /** 当前 run 所属执行树的根 run id。 */
  rootRunId?: string | null;
  /** 当前 run 的父 run id；root run 为 null。 */
  parentRunId?: string | null;
  /** 当前 run 在父 agent 下的调用 id；root run 为 null。 */
  runParentCallId?: string | null;
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
  /** run 入口来源；daemon* 用于交互工具立即挂起。 */
  executionKind?: string;
  /** 同一依赖就绪工具批次的稳定标识；backend 用它聚合审批并只恢复一次。 */
  interactionBatchId?: string;
  /** 交互请求已持久化后通知宿主适配器；不负责恢复或改变审批结果。 */
  onInteractionRequired?: (notice: {
    interactionId: string;
    sessionId: string;
    rootRunId: string;
    batchId: string;
    kind: "approval" | "user_input";
  }) => void;
  /** 整棵执行树的根任务文本；child run 继承，用于挂起后从 root 恢复。 */
  rootTask?: string;
  /** 发起当前 run 的用户；供宿主执行资源所有权校验，不暴露给模型。 */
  userId?: string | null;
  /** 当前 agent 名称。 */
  currentAgentName?: string | null;
  /** 工作空间根路径（文件类工具判断外部路径用）。 */
  workspaceRoot?: string | null;
  /** 当前有效上下文引用的会话附件；SaaS 沙箱据此执行最小权限挂载。 */
  attachmentFileIds?: readonly string[];
  /**
   * 委托执行指令发送（消费端注入，可选）：委托工具的 call 内部调此发 delegate_call 驱动宿主执行。
   * 由 createRuntime 从 options.emitDelegateCall 注入；SDK 内核不调用，仅供消费端构造的委托壳 Tool.call 使用。
   */
  emitDelegateCall?: (input: { toolCallId: string; toolName: string; arguments: Record<string, unknown> }) => void;
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

/** 实时输出导线（穿过 Protocol/Tool 内部），零翻译透传 KernelEvent 给 Dispatcher。 */
export interface EventSink {
  emit(event: KernelEvent): void;
}

/** 消息增量补充端口：循环②步补后台通知 + followup。 */
export interface MessageRefresher {
  /** Invoked at the start of each model round, before round.before hooks. */
  refresh(ctx: KernelContext, round: number): Promise<ChatMessage[]>;
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

/** 运行时 store 端口 + 落库 input 类型已删除（B2：SDK 收窄为纯计算内核，落库全归 backend ConversationStore + event-persister）。 */
