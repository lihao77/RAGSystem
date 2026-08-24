import { MSG_TYPE } from "../../../contracts/message-kinds.js";
import { TOOL_OUTPUT_TYPES, type ToolExecutionResult, type ToolOutputType } from "@ragsystem/agent-sdk";

interface DurableRoundMessage {
  metadata: Record<string, unknown>;
  tool_call_id?: string | undefined;
}

/** Restores durable tool results for the assistant round immediately preceding startRound. */
export function resolveResumeToolResults(
  messages: readonly (DurableRoundMessage | null)[],
  runId: string,
  startRound: number,
): ReadonlyMap<string, ToolExecutionResult> {
  const results = new Map<string, ToolExecutionResult>();
  if (startRound < 1) return results;
  for (const message of messages) {
    if (!message?.tool_call_id) continue;
    const metadata = message.metadata;
    if (metadata.run_id !== runId
      || metadata.msg_type !== MSG_TYPE.OBSERVATION
      || metadata.round !== startRound) continue;
    const result = parseToolResult(metadata.tool_result_ref);
    if (result) results.set(message.tool_call_id, result);
  }
  return results;
}

function parseToolResult(value: unknown): ToolExecutionResult | null {
  if (!isRecord(value)
    || typeof value.success !== "boolean"
    || typeof value.tool_name !== "string"
    || typeof value.summary !== "string") return null;
  return {
    success: value.success,
    toolName: value.tool_name,
    summary: value.summary,
    answer: typeof value.answer === "string" ? value.answer : null,
    // 持久化旧数据可能带非枚举值（历史自由字符串），归一到 json 默认档
    outputType: (TOOL_OUTPUT_TYPES as readonly string[]).includes(value.output_type as string)
      ? value.output_type as ToolOutputType
      : "json",
    content: value.content,
    metadata: isRecord(value.metadata) ? value.metadata : {},
    files: Array.isArray(value.files) ? value.files as ToolExecutionResult["files"] : [],
    llmHint: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 返回同一 durable run 下一次应该使用的 0-based round。
 *
 * 工具轮 assistant 行把逻辑轮次以 1-based metadata.round 持久化，因此最大值正好
 * 等于下一次 SDK 调用的 startRound。最终轮行（ROUND 无 tool_calls）不写 round 字段，
 * 由 round 校验自然跳过。只认当前 run 的轮次行（ROUND 及旧值 INTENT），避免同一
 * thread 中其他 root/child run 或终态消息污染轮次。
 */
export function resolveRunStartRound(
  messages: readonly (DurableRoundMessage | null)[],
  runId: string,
): number {
  let startRound = 0;
  for (const message of messages) {
    if (!message) continue;
    const metadata = message.metadata;
    if (metadata.run_id !== runId) continue;
    if (metadata.msg_type !== MSG_TYPE.ROUND) continue;
    const round = metadata.round;
    if (typeof round !== "number" || !Number.isSafeInteger(round) || round < 1) continue;
    startRound = Math.max(startRound, round);
  }
  return startRound;
}

interface BoundaryCandidateMessage {
  id: string;
  role: string;
  metadata: Record<string, unknown>;
}

/**
 * 恢复运行（suspend→resume / 重启续跑）时重建 boundary：取该 run 已认领的
 * 最新用户行（含插嘴）。新 persister 没有 initialMessage，不补则后续行落库
 * 无 boundary 盖章、wire 工具信封退回位置路由（插嘴场景 call/result 可能拆散）。
 */
export function resolveResumeBoundaryMessageId(
  messages: readonly (BoundaryCandidateMessage | null)[],
  runId: string,
): string | null {
  let boundary: string | null = null;
  for (const message of messages) {
    if (!message || message.role !== "user") continue;
    const metadata = message.metadata;
    const owned = metadata.run_id === runId || metadata.consumed_by_run_id === runId;
    if (owned && message.id) boundary = message.id;
  }
  return boundary;
}
