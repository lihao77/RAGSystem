/**
 * 压缩重建后的 observation 回补选择（runtime-adapter round.before 压缩成功分支用）。
 *
 * 设计场景：通用开始契约重执行的 tool_result 经 AsyncQueue 异步落库，replaceAll 重读 store 时
 * 可能尚未落库而被覆盖丢弃 → assistant tool_use 无 tool_result（Anthropic 400 insufficient tool messages）。
 *
 * 回补必须同时满足两个条件：
 * 1. rebuilt 中确实没有该 observation（丢了才需要补）；
 * 2. 对应 tool_use 仍在 rebuilt（恢复场景下悬空 tool_use 必在保留区尾部）。
 * 缺第 2 条，回补的就是刚被压缩替换掉的历史 observation——会成为无前置 tool_calls 的孤儿消息
 *（OpenAI 400: Messages with role 'tool' must be a response to a preceding message with 'tool_calls'）。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";

export function selectLostObservations(
  ctxMessages: readonly ChatMessage[],
  rebuilt: readonly ChatMessage[],
): ChatMessage[] {
  const rebuiltToolCallIds = new Set(
    rebuilt.filter((m) => m.role === "tool").map((m) => m.tool_call_id).filter((id): id is string => Boolean(id)),
  );
  const rebuiltToolUseIds = new Set(
    rebuilt
      .filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls))
      .flatMap((m) => (m.tool_calls ?? []).map((call) => call.id).filter((id): id is string => Boolean(id))),
  );
  return ctxMessages.filter(
    (m) => m.role === "tool"
      && typeof m.tool_call_id === "string"
      && !rebuiltToolCallIds.has(m.tool_call_id)
      && rebuiltToolUseIds.has(m.tool_call_id),
  );
}
