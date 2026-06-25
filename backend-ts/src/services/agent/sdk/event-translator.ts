/**
 * 事件翻译层（设计稿 §6 原则 4）—— SDK 扁平 KernelEvent → backend-ts Envelope。
 *
 * SDK 内核 emit 扁平 KernelEvent（camelCase，无 data 包裹）；Dispatcher 只落库+推流，不翻译。
 * 本翻译器把 KernelEvent 适配成 backend-ts 的 AgentRuntimeEvent 方言（snake_case + data 包裹），
 * 复用现有 AgentExecutionEventPublisher.publishRuntimeEvent 的全部 Envelope 构建逻辑——
 * 零重复实现 tool_call/tool_result/intent_complete 等 Envelope + run_step + message 落库。
 *
 * 字段映射要点：
 *   - camelCase → snake_case（toolCallId → tool_call_id 等）
 *   - tool_result：SDK 不内联 raw_result（大 payload 由 SDK observation 落盘成 artifact），
 *     故 raw_result/raw_result_ref/raw_result_available 置默认值；approval 从 metadata 读。
 */
import type { KernelEvent } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { AgentRuntimeEvent } from "../kernel/contracts.js";
import type { AgentExecutionEventPublisher } from "../execution/event-publisher.js";

/** 翻译器所需的执行上下文（与 AgentExecutionEventPublisher.publishRuntimeEvent 的入参对齐）。 */
export interface SdkEventTranslationContext {
  sessionId: string;
  runId: string;
  taskId: string;
  requestId: string;
  rootCallId: string;
  parentCallId?: string | null;
  agent: AgentConfig;
  threadKey: string;
  childAgentId?: string | null;
}

/**
 * 把单条 SDK KernelEvent 翻译成 AgentRuntimeEvent 方言，委托 publisher 落库 + 推 Envelope。
 *
 * 映射：只有需要实时 Envelope 的 KernelEvent 才翻译成 runtime.* 方言（委托 publisher 落 run_step + 推流）。
 * assistant_intermediate / observation_complete 是纯落库事件——SDK Dispatcher 已独占持久化（方案 A
 * 单 store 无双写），这里返回 null 不再触发 publisher.persistReactMessage，否则会与 SDK 双写 message。
 */
export function translateKernelEvent(
  event: KernelEvent,
  ctx: SdkEventTranslationContext,
  publisher: AgentExecutionEventPublisher,
): void {
  const runtimeEvent = toAgentRuntimeEvent(event);
  if (runtimeEvent) {
    publisher.publishRuntimeEvent(ctx, runtimeEvent);
  }
}

/** SDK KernelEvent → backend-ts AgentRuntimeEvent 方言（camelCase→snake_case + data 包裹）。 */
function toAgentRuntimeEvent(event: KernelEvent): AgentRuntimeEvent | null {
  switch (event.type) {
    case "first_token":
      return {
        type: "runtime.first_token",
        data: { elapsed_ms: event.elapsedMs, agent_name: event.agentName },
      };
    case "output_delta":
      return {
        type: "runtime.output_delta",
        data: { content: event.content, agent_name: event.agentName },
      };
    case "intent_delta":
      return {
        type: "runtime.intent_delta",
        data: { content: event.content, agent_name: event.agentName, round: event.round },
      };
    case "intent_complete":
      return {
        type: "runtime.intent_complete",
        data: { content: event.content, agent_name: event.agentName, round: event.round },
      };
    case "assistant_intermediate":
      // 纯落库事件：SDK Dispatcher.persistAssistantMessage 已写 message（含 react_intermediate/msg_type），
      // 翻译层不重复落库（方案 A 单 store）。无实时 Envelope（中间态不推前端）。
      return null;
    case "tool_call":
      return {
        type: "runtime.tool_call",
        data: {
          agent_name: event.agentName,
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          arguments: event.arguments,
          round: event.round,
          order: event.order,
          round_index: event.roundIndex,
        },
      };
    case "tool_result":
      // SDK 不内联 raw_result（大 payload 落盘成 observation artifact）；
      // publisher 从 metadata 读 approval_message/approval，raw_* 置默认值。
      return {
        type: "runtime.tool_result",
        data: {
          agent_name: event.agentName,
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          success: event.success,
          summary: event.summary,
          observation: event.observation,
          metadata: event.metadata,
          raw_result: {},
          raw_result_ref: {},
          raw_result_available: false,
          elapsed_time: event.elapsedTime,
          round: event.round,
          order: event.order,
          round_index: event.roundIndex,
        },
      };
    case "observation_complete":
      // 纯落库事件：SDK Dispatcher.persistObservations 已写 observation message，翻译层不重复落库。
      return null;
    case "error":
      return {
        type: "runtime.error",
        data: { message: event.message, agent_name: event.agentName },
      };
    case "context_usage":
      return {
        type: "runtime.context_usage",
        data: {
          agent_name: event.agentName,
          round: event.round,
          system_prompt_tokens: event.systemPromptTokens,
          history_tokens: event.historyTokens,
          used_tokens: event.totalTokens,
          total_tokens: event.totalTokens,
          budget_tokens: event.budgetTokens,
          compressing: event.compressing,
        },
      };
    default: {
      // 穷尽性守卫：新增 KernelEvent 类型时编译报错，强制补全翻译。
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}
