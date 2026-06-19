/**
 * Agent 微内核 — 契约层（纯类型，零运行时代码）。
 *
 * 本文件是内核与扩展点（Protocol / ToolProvider / EventSink / MessageRefresher / HookRegistry）
 * 之间唯一的耦合面。内核只依赖本文件的类型，绝不 import 任何具体实现。
 *
 * 来源（逐字迁入，行为零变化）：
 * - AgentRuntimeEvent / AgentRuntimeEventHandler：agent-runtime-core.ts L35-129
 * - KernelSession：AgentRuntimeRequest L131-143，去掉 onEvent / conversationUpdateProvider /
 *   onModelRequestSuccess 三回调（改由注入的 EventSink / MessageRefresher / Hook 承担）。
 * - KernelResult：AgentRuntimeResult L145-155。
 * - KernelToolCall / KernelObservation：对齐 tool-round-executor.ts 的 PreparedRoundToolCall /
 *   RuntimeToolRoundExecution 真实形状，不臆造字段。
 */

import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type {
  ChatCompletionRequest,
  ChatMessage,
} from "../../integrations/llm-chat-client.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolExecutor,
} from "../../runtime/runtime-tool-types.js";
import type { AgentPromptContext } from "../agent-prompt-builder.js";
import type { KernelContext } from "./kernel-context.js";
import type { PreparedRoundToolCall, RuntimeToolRoundExecution } from "../agent-runtime-core/tool-round-executor.js";
// KernelContext 定义在 kernel-context.ts；在此 re-export，使 contracts.ts 成为内核类型的统一出口。
export type { KernelContext } from "./kernel-context.js";

/**
 * 运行时事件（10 种类型，字段一字不改，从 agent-runtime-core.ts 整体迁入）。
 *
 * 下游分流（由 publishRuntimeEvent 决定，非内核/Protocol 职责）：
 * - output_delta / first_token / intent_delta / error：仅进 outbox 投递
 * - tool_call / tool_result / intent_complete：写 run_step + outbox（同事务）
 * - assistant_intermediate / observation_complete：写消息表（addMessage）
 * - runtime.done：现状为死事件（publishRuntimeEvent 无此分支，经 onEvent 透传后被静默丢弃）；
 *   保留仅为维持"10 种不变"。
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
      type: "runtime.done";
      data: {
        content: string;
        agent_name: string;
        finish_reason: string | null;
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
 * 形状对齐 tool-round-executor.ts 的 PreparedRoundToolCall，逐字一致。
 */
export type KernelToolCall = PreparedRoundToolCall;

/**
 * 单轮工具观测结果（内核执行 ToolProvider 后回填给 Protocol 的数据）。
 * 形状对齐 tool-round-executor.ts 的 RuntimeToolRoundExecution，逐字一致。
 */
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
 * 问模型 + 解析 + 发 delta 的协议端口（三只手之一）。
 * - buildRequest：吸收现 buildChatRequest（含 prompt 注入策略）。
 * - invoke：问模型 + 边流边解析 + 发 delta + 修复重试，全在内部。
 * - renderObservations：observation → 消息形态由协议决定（XML 协议为单条 user 消息）。
 */
export interface Protocol {
  buildRequest(ctx: KernelContext): ChatCompletionRequest;
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
