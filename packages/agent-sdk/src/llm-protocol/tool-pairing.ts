/**
 * 发送前 tool 配对兜底（native FC 物理边界的最后一道强制）。
 *
 * 协议约束：role:tool 消息必须是带对应 tool_calls 的前置 assistant 的响应
 *（OpenAI 400: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"）。
 * 上游各路径（历史构建 orphan guard、压缩选段对齐、压缩后回补）各自保证配对；
 * 此处是出口强制：孤立 tool 消息（无前置 assistant 携带同名 tool_call_id，或干脆缺 tool_call_id）
 * 直接丢弃——这类消息对模型本就无上下文意义，保住 run 比保住一条脏数据重要。
 * 同一 tool_call_id 的第二次应答同样丢弃（重复应答也触发上述 400——上游以配对错误
 * 的文案误报；曾由 refresh 索引错位注入重复 tool 消息，见 recent-messages-source
 * closeOrphanedToolCalls 的对齐修复）。去重窗口按 assistant 轮重开：后续 assistant
 * 重新声明同 id 视为新的一轮事务，其应答合法——适配器在 provider 不回 call id 时按
 * 响应内序号合成 id（如 tool_call_0），跨轮同 id 是合法形态，全局去重会误杀第二轮
 * 应答、制造历史中部的悬空 tool_calls。
 *
 * 悬空 tool_calls（assistant 有 tool_calls 但后续无 tool 结果）不在此处理：
 * 内核通用开始契约（kernel.collectUnansweredToolRound）负责恢复重执行，此处不动。
 *
 * 仅 native FC 路径需要本兜底；XML 协议把 role:tool 渲染为 role:user，不存在该约束。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";

export interface ToolPairingSanitizeResult {
  messages: ChatMessage[];
  /** 被丢弃的孤立/重复 tool 消息的 tool_call_id（缺失时为 "(missing)"；供测试与诊断断言）。 */
  droppedToolCallIds: string[];
}

export function sanitizeToolPairing(messages: readonly ChatMessage[]): ToolPairingSanitizeResult {
  const seenToolUseIds = new Set<string>();
  const answeredToolUseIds = new Set<string>();
  const droppedToolCallIds: string[] = [];
  const output: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!call.id) continue;
        seenToolUseIds.add(call.id);
        // 新一轮重新声明同 id → 重开应答窗口（适配器合成 id 跨轮重名的合法形态）。
        answeredToolUseIds.delete(call.id);
      }
    }
    if (message.role === "tool") {
      const id = message.tool_call_id;
      if (!id || !seenToolUseIds.has(id)) {
        droppedToolCallIds.push(id || "(missing)");
        continue;
      }
      if (answeredToolUseIds.has(id)) {
        droppedToolCallIds.push(id);
        continue;
      }
      answeredToolUseIds.add(id);
    }
    output.push(message);
  }
  if (droppedToolCallIds.length === 0) {
    return { messages: [...messages], droppedToolCallIds };
  }
  return { messages: output, droppedToolCallIds };
}
