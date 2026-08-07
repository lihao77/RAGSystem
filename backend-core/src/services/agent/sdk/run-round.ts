import { MSG_TYPE } from "../../../contracts/message-kinds.js";
import type { ToolExecutionResult } from "@ragsystem/agent-sdk";

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
    outputType: typeof value.output_type === "string" ? value.output_type : "unknown",
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
 * intent 消息把逻辑轮次以 1-based metadata.round 持久化，因此最大值正好等于
 * 下一次 SDK 调用的 startRound。只认当前 run 的 intent，避免同一 thread 中其他
 * root/child run 或终态消息污染轮次。
 */
export function resolveRunStartRound(
  messages: readonly (DurableRoundMessage | null)[],
  runId: string,
): number {
  let startRound = 0;
  for (const message of messages) {
    if (!message) continue;
    const metadata = message.metadata;
    if (metadata.run_id !== runId || metadata.msg_type !== MSG_TYPE.INTENT) continue;
    const round = metadata.round;
    if (typeof round !== "number" || !Number.isSafeInteger(round) || round < 1) continue;
    startRound = Math.max(startRound, round);
  }
  return startRound;
}
