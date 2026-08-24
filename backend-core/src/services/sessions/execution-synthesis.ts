/**
 * 执行视图合成：从 message 行（ROUND/OBSERVATION）重建前端执行树所需的 envelope 流。
 *
 * 数据源是消息表本身（思考来自行内 thinking part，一等内容），不再依赖 run_steps 归档；
 * 经 translateKernelEvent 翻译，保证与实时流 envelope 完全同构，前端 applyEnvelope 零改动。
 * 规则按形状判别、轮次均匀：带 tool_calls 的 assistant 行 → 思考+意图+工具调用，
 * 不带 tool_calls 的最终轮行（含 terminal salvage）→ 只回放思考（正文由消息槽
 * assistant 行承载，与 live final 相位让位语义一致）。
 */
import { partsToPlainText } from "@ragsystem/agent-protocol";
import type { KernelEvent } from "@ragsystem/agent-sdk";
import { translateKernelEvent, type WireTranslationContext } from "../agent/sdk/event-translation.js";
import type { Envelope } from "../../contracts/events.js";
import type { MessageInfo } from "../../contracts/session/session.js";
import { MSG_TYPE } from "../../contracts/message-kinds.js";

/** 从一个 run 的消息行合成执行树 envelope 流（内部按 seq 排序）。 */
export function synthesizeExecutionEnvelopes(
  rows: readonly MessageInfo[],
  ctx: Pick<WireTranslationContext, "sessionId" | "runId">,
): Envelope[] {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const agentName = agentNameOf(ordered[0]);
  const wireCtx: WireTranslationContext = {
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    rootCallId: ctx.runId,
    requestId: "",
    agentId: agentName,
  };
  const envelopes: Envelope[] = [];
  const emit = (event: KernelEvent): void => {
    envelopes.push(...translateKernelEvent(event, wireCtx));
  };
  // 最终轮行不写 metadata.round，kernel round 由本 run 已见最大轮次推导：工具轮
  // kernel 0..n-1（metadata.round 1..n）→ 最终轮 kernel n；无工具轮则为 0。
  // 只累计显式携带 round 的行——final 行自身的兜底 round 0 不得参与推导。
  let maxKernelRound = -1;
  for (const row of ordered) {
    if (hasExplicitRound(row)) {
      const explicit = kernelRoundOf(row);
      if (explicit > maxKernelRound) maxKernelRound = explicit;
    }
    if (row.role === "assistant" && (row.tool_calls?.length ?? 0) > 0) {
      const round = kernelRoundOf(row);
      const thinking = row.content_parts.find((part) => part.type === "thinking");
      if (thinking && thinking.type === "thinking" && thinking.text) {
        emit({ type: "reasoning_complete", agentName, content: thinking.text, round });
      }
      const intentText = partsToPlainText(row.content_parts);
      if (intentText) {
        emit({ type: "intent_complete", agentName, content: intentText, round });
      }
      for (const call of row.tool_calls ?? []) {
        emit({
          type: "tool_call",
          agentName,
          toolCallId: call.id,
          toolName: call.function.name,
          arguments: safeParseArguments(call.function.arguments),
          round,
          order: 0,
          roundIndex: 0,
        });
      }
      continue;
    }
    if (row.role === "assistant" && (row.tool_calls?.length ?? 0) === 0) {
      // 最终轮/terminal salvage（ROUND 无 tool_calls）：只回放思考——
      // 正文由消息槽 assistant 行渲染（live 的 final 相位同样把轮 text 让位给消息行，
      // 最终答案只出现一次）；中断轮的半截思考同样进树（树是思考的唯一出口）。
      const thinking = row.content_parts.find((part) => part.type === "thinking");
      if (thinking && thinking.type === "thinking" && thinking.text) {
        emit({
          type: "reasoning_complete",
          agentName,
          content: thinking.text,
          round: maxKernelRound + 1,
        });
      }
      continue;
    }
    if (row.role === "tool" && row.metadata?.msg_type === MSG_TYPE.OBSERVATION && row.tool_call_id) {
      const round = kernelRoundOf(row);
      const reference = asRecord(row.metadata?.tool_result_ref);
      // 终局补齐的悬空工具行（run 中断/失败）：无 tool_result_ref，按 terminal_status
      // 判失败/中断——与 live 的 terminal tool_result envelope 同口径，不误显成功。
      const terminalToolStatus = row.metadata?.terminal_tool_result === true
        && typeof row.metadata?.terminal_status === "string"
        ? row.metadata.terminal_status
        : null;
      emit({
        type: "tool_result",
        agentName,
        toolCallId: row.tool_call_id,
        toolName: row.name ?? "tool",
        success: terminalToolStatus ? false : reference?.ok !== false && reference?.success !== false,
        summary: "",
        observation: partsToPlainText(row.content_parts),
        metadata: terminalToolStatus ? { terminal_status: terminalToolStatus } : {},
        referenceResult: reference ?? {},
        elapsedTime: 0,
        round,
        order: 0,
        roundIndex: 0,
      });
    }
  }
  // 生命周期收尾：合成回放的是已终结的 run，补 agent_ended 让树根拿到终态——
  // 前端以根状态推断运行态（Steps 的 running），缺终态会把历史回放误判为运行中。
  const terminalRow = ordered.find(isTerminalRow);
  const terminalStatus = terminalRow?.metadata?.terminal_status;
  const terminalReason = terminalRow?.metadata?.terminal_reason;
  envelopes.push({
    type: "agent_ended",
    session_id: ctx.sessionId,
    run_id: ctx.runId,
    call_id: ctx.runId,
    agent_id: agentName,
    payload: terminalRow
      ? {
        phase: "end",
        status: terminalStatus === "failed" ? "failed" : "interrupted",
        success: false,
        ...(typeof terminalReason === "string" && terminalReason ? { result: terminalReason } : {}),
      }
      : { phase: "end", status: "succeeded", success: true },
  });
  return envelopes;
}

/** terminal 行（中断/失败 salvage）暂不进执行树，思考由消息气泡渲染；待中断终态视觉后接入。 */
function isTerminalRow(row: MessageInfo): boolean {
  return typeof row.metadata?.terminal_status === "string";
}

/** persister 落库的 metadata.round 是 kernel round + 1（展示序号从 1 起）；缺失时兜底 0。 */
function kernelRoundOf(row: MessageInfo): number {
  const round = row.metadata?.round;
  return typeof round === "number" && Number.isFinite(round) && round > 0 ? Math.floor(round) - 1 : 0;
}

function hasExplicitRound(row: MessageInfo): boolean {
  const round = row.metadata?.round;
  return typeof round === "number" && Number.isFinite(round) && round > 0;
}

function agentNameOf(row: MessageInfo | undefined): string {
  const name = row?.metadata?.agent_name;
  return typeof name === "string" && name ? name : "agent";
}

function safeParseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
