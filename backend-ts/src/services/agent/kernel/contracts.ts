/**
 * Agent 微内核 — 契约层（纯类型，零运行时代码）。
 *
 * 本文件是内核与扩展点（Protocol / ToolProvider / EventSink / MessageRefresher / HookRegistry）
 * 之间唯一的耦合面。内核只依赖本文件的类型，绝不 import 任何具体实现。
 *
 * 设计要点：
 * - KernelSession：去掉 onEvent / conversationUpdateProvider / onModelRequestSuccess
 *   三回调（改由注入的 EventSink / MessageRefresher / Hook 承担）。
 * - PreparedRoundToolCall / RuntimeToolRoundExecution 定义于本文件（依赖倒置：
 *   内核契约不反向 import 下层零件）。
 * - KernelToolCall / KernelObservation：即上述两个 interface 的语义别名，不臆造字段。
 */

import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { ChatMessage } from "../../integrations/llm-chat-client.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolExecutor,
  ToolExecutionResult,
} from "../../runtime/runtime-tool-types.js";
import type { AgentPromptContext } from "../prompt-builder/index.js";
import type { KernelContext } from "./kernel-context.js";
// KernelContext 定义在 kernel-context.ts；在此 re-export，使 contracts.ts 成为内核类型的统一出口。
export type { KernelContext } from "./kernel-context.js";

/**
 * 运行时事件（9 种类型）。
 *
 * 下游分流（由 publishRuntimeEvent 决定，非内核/Protocol 职责）：
 * - output_delta / first_token / intent_delta / error：仅进 outbox 投递
 * - tool_call / tool_result / intent_complete：写 run_step + outbox（同事务）
 * - assistant_intermediate / observation_complete：写消息表（addMessage）
 *
 * 运行结束不再发事件：内核循环结束直接返回 result，由 run-engine 据返回值落终态，
 * 无需运行时事件透传（旧 runtime.done 是无下游消费的死事件，已删）。
 */
export type AgentRuntimeEvent =
  | {
      type: "runtime.first_token";
      data: {
        elapsed_ms: number;
        agent_name: string;
      };
    }
  | {
      type: "runtime.output_delta";
      data: {
        content: string;
        agent_name: string;
      };
    }
  | {
      type: "runtime.intent_delta";
      data: {
        content: string;
        agent_name: string;
        round: number;
      };
    }
  | {
      type: "runtime.intent_complete";
      data: {
        content: string;
        agent_name: string;
        round: number;
      };
    }
  | {
      type: "runtime.assistant_intermediate";
      data: {
        content: string;
        agent_name: string;
        round: number;
      };
    }
  | {
      type: "runtime.tool_call";
      data: {
        agent_name: string;
        tool_call_id: string;
        tool_name: string;
        arguments: Record<string, unknown>;
        round: number;
        order: number;
        round_index: number;
      };
    }
  | {
      type: "runtime.tool_result";
      data: {
        agent_name: string;
        tool_call_id: string;
        tool_name: string;
        success: boolean;
        summary: string;
        observation: string;
        metadata: Record<string, unknown>;
        raw_result: Record<string, unknown>;
        raw_result_ref: Record<string, unknown>;
        raw_result_available: boolean;
        elapsed_time: number;
        round: number;
        order: number;
        round_index: number;
      };
    }
  | {
      type: "runtime.observation_complete";
      data: {
        content: string;
        agent_name: string;
        round: number;
      };
    }
  | {
      type: "runtime.error";
      data: {
        message: string;
        agent_name: string;
      };
    };

export type AgentRuntimeEventHandler = (event: AgentRuntimeEvent) => void | Promise<void>;

/**
 * 单轮工具调用申请（Protocol 向内核提交的"申请"，执行权在内核）。
 */
export interface PreparedRoundToolCall {
  index: number;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/** KernelToolCall = PreparedRoundToolCall（语义别名，保留内核命名）。 */
export type KernelToolCall = PreparedRoundToolCall;

/**
 * 单轮工具观测结果（内核执行 ToolProvider 后回填给 Protocol 的数据）。
 */
export interface RuntimeToolRoundExecution {
  index: number;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: ToolExecutionResult;
  observation: string;
}

/** KernelObservation = RuntimeToolRoundExecution（语义别名，保留内核命名）。 */
export type KernelObservation = RuntimeToolRoundExecution;

/**
 * 一次 invoke 的产物：要么是最终回答（final），要么是工具调用申请（tool_calls）。
 * Protocol 在单次 invoke 内部完成"问模型 + 边流边解析 + 发 delta + 修复重试"，
 * maxProtocolRepairAttempts=2 的重试整段在 invoke 内消化，不递增内核 round。
 */
export type KernelOutcome =
  | {
      kind: "final";
      finalAnswer: string;
      assistantMessage: ChatMessage;
      finishReason: string | null;
    }
  | {
      kind: "tool_calls";
      calls: KernelToolCall[];
      assistantMessage: ChatMessage;
      finishReason: string | null;
    };

/**
 * 一次 run 的最终结果（对齐 AgentRuntimeResult L145-155）。
 */
export interface KernelResult {
  content: string;
  raw?: unknown;
  finish_reason: string | null;
  metadata: {
    agent_name: string;
    provider_key: string | null;
    provider_type: string;
    model_name: string;
  };
}

/**
 * 钩子点：beforeModel（轮首、refresh 之后、问模型之前）；
 * afterModel（问模型返回之后，取代 onModelRequestSuccess，用于刷 stable-prefix 缓存）。
 */
export type HookPoint = "beforeModel" | "afterModel";

/**
 * 工具指令形态：决定 Context 是否注入 XML 协议说明。
 * - "xml"：注入 XML <tool_calls> 用法说明（XmlProtocol）。
 * - "native"：走厂商 function calling，不注入 XML 说明（Hybrid 协议，阶段二后续）。
 * 由 selectProtocol 决定的协议形态产出，装配层绑进 Context 实例，不渗进内核。
 */
export type ToolInstructionMode = "xml" | "native";

/**
 * 上下文构建端口（三只手之一）——把会话累积组装成发给模型的消息。
 * 只管"喂什么消息"：system prompt + stable context + 按 toolInstructionMode 决定是否
 * 注入 XML 协议说明 + conversation 渲染。请求壳（model/provider/temperature/signal）
 * 下沉到 Protocol.invoke。每轮由内核在 beforeModel 后、invoke 前调用，产物写入
 * ctx.requestMessages，与 ctx.messages（会话累积）分离。
 */
export interface Context {
  buildMessages(ctx: KernelContext): ChatMessage[];
}

/**
 * 问模型 + 解析 + 发 delta 的协议端口（三只手之一）。
 * - invoke：问模型 + 边流边解析 + 发 delta + 修复重试，全在内部；读 ctx.requestMessages
 *   作为下发请求的 messages，自包请求壳（model/provider/temperature/signal）。
 * - renderObservations：observation → 消息形态由协议决定（XML 协议为单条 user 消息）。
 */
export interface Protocol {
  invoke(ctx: KernelContext, round: number): Promise<KernelOutcome>;
  renderObservations(calls: KernelToolCall[], observations: KernelObservation[]): ChatMessage[];
}

/**
 * 工具执行端口（三只手之一）。必须持有 EventSink，否则 tool_call/tool_result 断流。
 */
export interface ToolProvider {
  executeRound(ctx: KernelContext, round: number, calls: KernelToolCall[]): Promise<KernelObservation[]>;
}

/**
 * 实时输出导线（穿过 Protocol/Tool 内部），零翻译透传到 publishRuntimeEvent。
 * 内核几乎不用它（顶多最后 done/error）。
 */
export interface EventSink {
  emit(event: AgentRuntimeEvent): void;
}

/**
 * 消息增量补充端口（取代 conversationUpdateProvider）：循环②步补后台通知 + followup。
 */
export interface MessageRefresher {
  refresh(ctx: KernelContext): Promise<ChatMessage[]>;
}

/**
 * 钩子注册表：invoke 顺序 await 执行该 point 下所有 fn。
 */
export interface HookRegistry {
  invoke(point: HookPoint, ctx: KernelContext, round?: number): Promise<void>;
  register(point: HookPoint, fn: (ctx: KernelContext, round?: number) => void | Promise<void>): void;
}

/**
 * 一次 run 的输入（对齐 AgentRuntimeRequest L131-143）。
 * 去掉了 onEvent / conversationUpdateProvider / onModelRequestSuccess 三回调——
 * 它们改为注入的 EventSink / MessageRefresher / Hook。
 *
 * conversation 是只读初始快照；KernelContext 持其拷贝作为可变工作副本。
 * requestId / taskId / rootCallId 可能为 null（child run）。
 */
export interface KernelSession {
  agent: AgentConfig;
  provider: ModelProviderConfig;
  modelName: string;
  conversation: ChatMessage[];
  promptContext?: AgentPromptContext | undefined;
  toolContext?: RuntimeToolExecutionContext | undefined;
  toolExecutor?: RuntimeToolExecutor | undefined;
  signal?: AbortSignal | undefined;
  sessionId: string;
  runId: string;
  taskId: string | null;
  requestId: string | null;
  rootCallId: string | null;
  threadKey?: string | undefined;
}
