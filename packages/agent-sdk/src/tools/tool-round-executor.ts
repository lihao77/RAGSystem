/**
 * 单轮工具执行编排（迁自 backend-ts tool-round-executor.ts）。
 *
 * ReAct 循环工具执行的"发动机"：把内核转交来的 calls 编排执行，产出 observation。
 * 顺序：依赖序分批（{result_N} 未满足的推后）→ 每批内 runToolBatchWithScheduler 并发/串行 →
 * 逐个 executeSingleToolCall（{result_N} 解析 → toolExecutor.executeTool → observation 渲染）→
 * emit tool_call/tool_result → 后台 wait 透传。
 *
 * observation 渲染在执行后立刻发生（buildLlmFacingToolResult + renderToolResultContent），
 * 是 ReAct 的有机部分——它决定下一轮模型看到什么。
 *
 * 与 backend-ts 差异：
 * - agent: AgentConfig → profile: AgentProfile；provider: ModelProviderConfig → ProviderConfig。
 * - 事件 runtime.tool_call/runtime.tool_result(data 包裹) → 扁平 ToolCallEvent/ToolResultEvent。
 * - result 字段 snake_case → camelCase；raw_result/observation 字段从事件精简（消费端按需取）。
 * - buildLlmFacingToolResult/renderToolResultContent 从 tools/observation.ts 取。
 */
import type { ProviderConfig } from "@ragsystem/agent-llm";
import { isAbortError, throwIfAborted } from "@ragsystem/agent-protocol";
import type { ToolExecutionResult, ToolExecutor, ToolExecutorCall, ToolExecContext, ToolWaitRequest, ToolWaitResult } from "../contracts.js";
import type { KernelToolCall, KernelObservation, EventSink } from "../contracts.js";
import type { AgentProfile } from "../types.js";
import { buildLlmFacingToolResult, renderToolResultContent } from "./observation.js";
import { runToolBatchWithScheduler } from "./scheduler.js";
import { buildToolExecutionErrorResult, buildToolReferenceErrorResult, collectResultPlaceholders, collectResultReferenceIndexes, resolveToolArgumentReferences } from "./tool-references.js";

interface ToolObservationResult {
  success: boolean;
  summary: string;
  observation: string;
  rawResult: Record<string, unknown>;
}

export interface ToolRoundExecutorOptions {
  toolExecutor: ToolExecutor;
  toolContext: ToolExecContext;
  dataRoot: string;
  round: number;
  agentName: string;
  profile: AgentProfile;
  provider: ProviderConfig;
  events: EventSink;
}

export async function executeToolCallRound(calls: KernelToolCall[], opts: ToolRoundExecutorOptions): Promise<KernelObservation[]> {
  const roundResults = new Map<number, ToolExecutionResult>();
  const executions = new Map<number, KernelObservation>();
  const batches = buildExecutionBatches(calls);
  for (const batch of batches) {
    throwIfAborted(opts.toolContext.signal, "Agent run aborted");
    const runCall = (call: KernelToolCall) =>
      executeSingleToolCall({ call, previousResults: roundResults, opts });
    const batchExecutions = await runToolBatchWithScheduler(batch, {
      signal: opts.toolContext.signal,
      classify: (call) =>
        opts.toolExecutor.classifyConcurrency?.(
          { toolName: call.toolName, arguments: resolveToolArgumentReferences(call.arguments, roundResults), callId: call.callId },
          buildToolCallExecutionContext(opts.toolContext, { callId: call.callId, round: opts.round, index: call.index }),
        ) ?? false,
      run: runCall,
    });
    throwIfAborted(opts.toolContext.signal, "Agent run aborted");
    for (const execution of batchExecutions) {
      roundResults.set(execution.index + 1, execution.result);
      executions.set(execution.index, execution);
    }
  }
  return [...executions.values()].sort((left, right) => left.index - right.index);
}

async function executeSingleToolCall(input: { call: KernelToolCall; previousResults: Map<number, ToolExecutionResult>; opts: ToolRoundExecutorOptions }): Promise<KernelObservation> {
  const { call, previousResults, opts } = input;
  const toolContext = buildToolCallExecutionContext(opts.toolContext, { callId: call.callId, round: opts.round, index: call.index });
  throwIfAborted(toolContext.signal, "Agent run aborted");
  const order = call.index + 1;
  const toolArguments = resolveToolArgumentReferences(call.arguments, previousResults);
  opts.events.emit({
    type: "tool_call",
    agentName: opts.agentName,
    toolCallId: call.callId,
    toolName: call.toolName,
    arguments: toolArguments,
    round: opts.round,
    order,
    roundIndex: order,
  });

  const startedAt = Date.now();
  const unresolvedPlaceholders = collectResultPlaceholders(toolArguments);
  const toolResult = unresolvedPlaceholders.length
    ? buildToolReferenceErrorResult(call.toolName, unresolvedPlaceholders)
    : await executeToolSafely({ toolExecutor: opts.toolExecutor, toolContext, toolExecutorCall: { toolName: call.toolName, arguments: toolArguments, callId: call.callId } });
  throwIfAborted(toolContext.signal, "Agent run aborted");
  const observationResult = await resolveToolObservation({ toolExecutor: opts.toolExecutor, toolContext, callId: call.callId, toolName: call.toolName, result: toolResult, opts });
  throwIfAborted(toolContext.signal, "Agent run aborted");
  const elapsedTime = (Date.now() - startedAt) / 1000;
  opts.events.emit({
    type: "tool_result",
    agentName: opts.agentName,
    toolCallId: call.callId,
    toolName: call.toolName,
    success: observationResult.success,
    summary: observationResult.summary,
    observation: observationResult.observation,
    metadata: toolResult.metadata,
    elapsedTime,
    round: opts.round,
    order,
    roundIndex: order,
  });

  return { index: call.index, callId: call.callId, toolName: call.toolName, arguments: toolArguments, result: toolResult, observation: observationResult.observation };
}

function buildExecutionBatches(calls: KernelToolCall[]): KernelToolCall[][] {
  const batches: KernelToolCall[][] = [];
  const completed = new Set<number>();
  let remaining = [...calls];
  while (remaining.length > 0) {
    const batch: KernelToolCall[] = [];
    const nextRemaining: KernelToolCall[] = [];
    for (const call of remaining) {
      if (toolCallHasUnmetDependencies(call, completed)) {
        nextRemaining.push(call);
      } else {
        batch.push(call);
      }
    }
    if (batch.length === 0) {
      const [first, ...rest] = remaining;
      if (first) { batch.push(first); }
      remaining = rest;
    } else {
      remaining = nextRemaining;
    }
    for (const call of batch) { completed.add(call.index + 1); }
    batches.push(batch);
  }
  return batches;
}

function toolCallHasUnmetDependencies(call: KernelToolCall, completed: Set<number>): boolean {
  const dependencies = collectResultReferenceIndexes(call.arguments);
  return dependencies.some((index) => !completed.has(index));
}

async function executeToolSafely(input: { toolExecutor: ToolExecutor; toolContext: ToolExecContext; toolExecutorCall: ToolExecutorCall }): Promise<ToolExecutionResult> {
  try {
    return await input.toolExecutor.executeTool(input.toolExecutorCall, input.toolContext);
  } catch (error) {
    if (isAbortError(error) || input.toolContext.signal?.aborted) { throw error; }
    return buildToolExecutionErrorResult(input.toolExecutorCall.toolName, error);
  }
}

async function resolveToolObservation(input: { toolExecutor: ToolExecutor; toolContext: ToolExecContext; callId: string; toolName: string; result: ToolExecutionResult; opts: ToolRoundExecutorOptions }): Promise<ToolObservationResult> {
  throwIfAborted(input.toolContext.signal, "Agent run aborted");
  const waitSignal = extractToolWaitSignal(input.result);
  if (!waitSignal || !input.toolExecutor.waitForToolResult) {
    try {
      const llmFacingResult = await buildLlmFacingToolResult({
        toolContext: input.toolContext,
        toolName: input.toolName,
        result: input.result,
        profile: input.opts.profile,
        provider: input.opts.provider,
        dataRoot: input.opts.dataRoot,
      });
      return {
        success: input.result.success,
        summary: input.result.summary,
        observation: renderToolResultContent({ callId: input.callId, toolName: input.toolName, result: llmFacingResult }),
        rawResult: materializeForRef(input.result),
      };
    } catch (error) {
      if (isAbortError(error) || input.toolContext.signal?.aborted) { throw error; }
      const errorResult = buildToolExecutionErrorResult(input.toolName, new Error(`Tool result observation failed: ${error instanceof Error ? error.message : String(error)}`));
      return {
        success: false,
        summary: errorResult.summary,
        observation: renderToolResultContent({ callId: input.callId, toolName: input.toolName, result: errorResult }),
        rawResult: materializeForRef(errorResult),
      };
    }
  }

  const waitReq: ToolWaitRequest = { backgroundTaskId: waitSignal.backgroundTaskId };
  if (waitSignal.timeoutMs !== null && waitSignal.timeoutMs !== undefined) { waitReq.timeoutMs = waitSignal.timeoutMs; }
  const waitResult = await input.toolExecutor.waitForToolResult(waitReq, input.toolContext);
  throwIfAborted(input.toolContext.signal, "Agent run aborted");
  return {
    success: waitResult.success,
    summary: summarizeBackgroundWaitResult(waitResult),
    observation: renderBackgroundWaitObservation(waitResult),
    rawResult: { background_notifications: waitResult.payloads },
  };
}

function buildToolCallExecutionContext(context: ToolExecContext, input: { callId: string; round: number; index: number }): ToolExecContext {
  const order = input.index + 1;
  return { ...context, toolCallId: input.callId, round: input.round, order, roundIndex: order };
}

function extractToolWaitSignal(result: ToolExecutionResult): { backgroundTaskId: string; timeoutMs?: number | null } | null {
  for (const payload of [result.content, result.metadata]) {
    if (!isRecord(payload) || payload.suggest_wait !== true) { continue; }
    const backgroundTaskId = asNonEmptyString(payload.background_task_id);
    if (!backgroundTaskId) { continue; }
    return { backgroundTaskId, timeoutMs: typeof payload.wait_timeout_ms === "number" && Number.isFinite(payload.wait_timeout_ms) ? payload.wait_timeout_ms : null };
  }
  return null;
}

function renderBackgroundWaitObservation(waitResult: ToolWaitResult): string {
  return waitResult.payloads.map((payload) => renderBackgroundNotification(payload, waitResult.timeout)).filter((content) => content.trim()).join("\n\n");
}

function renderBackgroundNotification(payload: Record<string, unknown>, timeout: boolean): string {
  const taskId = asNonEmptyString(payload.background_task_id) ?? asNonEmptyString(payload.task_id) ?? "unknown";
  const status = asNonEmptyString(payload.status) ?? (timeout ? "running" : "completed");
  const outputPath = asNonEmptyString(payload.output_path) ?? asNonEmptyString(payload.background_output_path);
  const returnCode = payload.return_code;
  const resultType = asNonEmptyString(payload.result_type);
  const summary = asNonEmptyString(payload.summary) ?? asNonEmptyString(payload.description);
  const parts = ["<task-notification>", `<task-id>${escapeXmlText(taskId)}</task-id>`];
  if (outputPath) { parts.push(`<output-file>${escapeXmlText(outputPath)}</output-file>`); }
  parts.push(`<status>${escapeXmlText(status)}</status>`);
  if (returnCode !== null && returnCode !== undefined) { parts.push(`<return-code>${escapeXmlText(String(returnCode))}</return-code>`); }
  if (resultType) { parts.push(`<result-type>${escapeXmlText(resultType)}</result-type>`); }
  if (summary) { parts.push(`<summary>${escapeXmlText(summary)}</summary>`); }
  parts.push("</task-notification>");
  return parts.join("\n");
}

function summarizeBackgroundWaitResult(waitResult: ToolWaitResult): string {
  const summaries = waitResult.payloads.map((payload) => asNonEmptyString(payload.summary)).filter((summary): summary is string => Boolean(summary));
  if (summaries.length > 0) { return summaries.join("\n\n"); }
  return waitResult.timeout ? "后台任务仍在运行" : "后台任务已完成";
}

function materializeForRef(result: ToolExecutionResult): Record<string, unknown> {
  return { success: result.success, tool_name: result.toolName, summary: result.summary, content: result.content, metadata: result.metadata };
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
