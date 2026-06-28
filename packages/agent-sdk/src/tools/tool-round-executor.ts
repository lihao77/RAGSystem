/**
 * 单轮工具执行编排——SDK 工具体系的发动机。
 *
 * ReAct 循环工具执行：calls → 依赖序分批 → 每批内并发/串行 →
 * 逐个 executeSingleToolCall（prepare → 审批 → hook.before → tool.call → hook.after/error → observation 渲染）
 * → emit tool_call/tool_result → 后台 wait 透传。
 *
 * 审批编排内置：prepare 产出权限信号 → policy 判定（含 prepare 的 riskLevel/forceAsk/approvedExternalPaths）
 * → ask 阻塞等待 → 放行/拒绝。不注入 policy 即全部 allow。
 */
import type { ProviderConfig } from "@ragsystem/agent-llm";
import { isAbortError, throwIfAborted } from "@ragsystem/agent-protocol";
import type {
  ToolExecutionResult,
  ToolExecContext,
  ToolWaitRequest,
  ToolWaitResult,
} from "../contracts.js";
import type { KernelToolCall, KernelObservation, EventSink } from "../contracts.js";
import type { HookRegistry } from "../hooks/types.js";
import type { AgentProfile } from "../types.js";
import type { ToolRegistry } from "./registry.js";
import type { PreparedTool } from "./preparer.js";
import { prepareTool } from "./preparer.js";
import { buildLlmFacingToolResult, renderToolResultContent } from "./observation.js";
import { runToolBatchWithScheduler } from "./scheduler.js";
import {
  buildToolExecutionErrorResult,
  buildToolReferenceErrorResult,
  collectResultPlaceholders,
  collectResultReferenceIndexes,
  resolveToolArgumentReferences,
} from "./tool-references.js";

interface ToolObservationResult {
  success: boolean;
  summary: string;
  observation: string;
  rawResult: Record<string, unknown>;
}

export interface ToolRoundExecutorOptions {
  /** 工具注册表（SDK 定义的 Tool 实例集合）。 */
  registry: ToolRegistry;
  toolContext: ToolExecContext;
  dataRoot: string;
  round: number;
  agentName: string;
  profile: AgentProfile;
  provider: ProviderConfig;
  events: EventSink;
  /** 事件 Hook 注册表（tool.before/gate/after/error）。permission 经 tool.gate handler 实现（由 createRuntime 注册）。 */
  hooks?: HookRegistry;
  /** 后台任务等待回调（消费端注入；不提供则忽略 suggest_wait 信号）。 */
  waitForToolResult?: (request: ToolWaitRequest, ctx: ToolExecContext) => ToolWaitResult | Promise<ToolWaitResult>;
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
      classify: (call) => {
        const resolved = resolveToolArgumentReferences(call.arguments, roundResults);
        return opts.registry.classifyConcurrency(call.toolName, resolved);
      },
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

async function executeSingleToolCall(input: {
  call: KernelToolCall;
  previousResults: Map<number, ToolExecutionResult>;
  opts: ToolRoundExecutorOptions;
}): Promise<KernelObservation> {
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

  let toolResult: ToolExecutionResult;
  if (unresolvedPlaceholders.length) {
    toolResult = buildToolReferenceErrorResult(call.toolName, unresolvedPlaceholders);
  } else {
    // prepare → approve → hook.before → tool.call → hook.after/error
    toolResult = await prepareAndExecute({
      toolName: call.toolName,
      toolArguments,
      toolContext,
      opts,
    });
  }

  throwIfAborted(toolContext.signal, "Agent run aborted");
  const observationResult = await resolveToolObservation({
    toolContext,
    callId: call.callId,
    toolName: call.toolName,
    result: toolResult,
    opts,
  });
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

/**
 * prepare → hook.before（可 deny/改入参）→ 审批编排 → tool.call → hook.after（可改结果）/hook.error。
 * hook 是智能层（先跑、可改判/改入参），permission 是兜底安全网（对最终入参判定）。
 * 全流程内置，消费端只提供 Tool 实例 + 可选审批端口。
 */
async function prepareAndExecute(input: {
  toolName: string;
  toolArguments: Record<string, unknown>;
  toolContext: ToolExecContext;
  opts: ToolRoundExecutorOptions;
}): Promise<ToolExecutionResult> {
  const { toolName, toolArguments, toolContext, opts } = input;

  // 1. prepare（校验 + 权限自检 + 路径收集）
  const prepareResult = prepareTool(
    { registry: opts.registry },
    toolName,
    toolArguments,
    toolContext,
  );
  if (!prepareResult.ok) {
    return prepareResult.result;
  }
  let prepared = prepareResult.prepared;

  // 2. hook.before：可 deny（跳过工具）或 modifiedInput（re-prepare 校验后替换）
  if (opts.hooks) {
    const hookOut = await opts.hooks.emit("tool.before", { toolName, arguments: prepared.input, ctx: toolContext });
    throwIfAborted(toolContext.signal, "Agent run aborted");
    if (hookOut.decision === "deny") {
      return buildToolExecutionErrorResult(prepared.tool.name, new Error(hookOut.reason ?? `工具 ${prepared.tool.name} 被 hook 拒绝`));
    }
    if (hookOut.modifiedInput) {
      const reprepared = prepareTool({ registry: opts.registry }, prepared.tool.name, hookOut.modifiedInput, toolContext);
      if (!reprepared.ok) {
        return reprepared.result;
      }
      prepared = reprepared.prepared;
    }
  }

  // 3. tool.gate：门禁最终入参（permission 等挂这里）。deny→跳过；approvedPaths→回填执行 ctx。
  //    无 hooks 时仍把 prepare 收集的外部路径候选回填（工具据此自判路径准入）。
  let gateApprovedPaths: string[] | undefined;
  if (opts.hooks) {
    const gateOut = await opts.hooks.emit("tool.gate", {
      toolName: prepared.tool.name,
      arguments: prepared.input,
      ctx: toolContext,
      riskLevel: prepared.permission?.riskLevel ?? prepared.tool.riskLevel ?? "low",
      forceAsk: prepared.permission?.action === "ask",
      approvalExempt: prepared.tool.approvalExempt ?? false,
      approvedExternalPaths: prepared.approvedExternalPaths,
    });
    throwIfAborted(toolContext.signal, "Agent run aborted");
    if (gateOut.decision === "deny") {
      return buildToolExecutionErrorResult(prepared.tool.name, new Error(gateOut.reason ?? `工具 ${prepared.tool.name} 被门禁拒绝`));
    }
    gateApprovedPaths = gateOut.approvedPaths;
  }
  const execContext = mergeApprovedPaths(toolContext, prepared.approvedExternalPaths, gateApprovedPaths);

  // 4. tool.call + hook.after（可改结果）/ hook.error
  return executeToolWithHookError({ prepared, execContext, ...(opts.hooks ? { hooks: opts.hooks } : {}) });
}

/**
 * 把审批通过/收集的外部路径合并回 ToolExecContext（去重；无变化则返回原 ctx）。
 */
function mergeApprovedPaths(ctx: ToolExecContext, ...sources: Array<string[] | undefined>): ToolExecContext {
  const existing = ctx.approvedExternalPaths ?? [];
  const collected: string[] = [];
  for (const source of sources) {
    if (source) { collected.push(...source); }
  }
  const merged = dedupeStrings([...existing, ...collected]);
  const sameLength = merged.length === existing.length;
  if (sameLength && merged.every((p, i) => p === existing[i])) {
    return ctx;
  }
  return { ...ctx, approvedExternalPaths: merged };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") { continue; }
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) { continue; }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

/** tool.call + hook.after（可改结果）/hook.error 包装。 */
async function executeToolWithHookError(input: {
  prepared: PreparedTool;
  execContext: ToolExecContext;
  hooks?: HookRegistry;
}): Promise<ToolExecutionResult> {
  const { prepared, execContext, hooks } = input;
  try {
    let result = await prepared.tool.call(prepared.input, execContext);
    if (hooks && result.success) {
      const hookOut = await hooks.emit("tool.after", {
        toolName: prepared.tool.name,
        arguments: prepared.input,
        result,
        ctx: execContext,
      });
      if (hookOut.modifiedResult) {
        result = hookOut.modifiedResult;
      }
    }
    return result;
  } catch (error) {
    if (isAbortError(error) || execContext.signal?.aborted) { throw error; }
    if (hooks) {
      await hooks.emit("tool.error", {
        toolName: prepared.tool.name,
        arguments: prepared.input,
        error,
        ctx: execContext,
      });
    }
    return buildToolExecutionErrorResult(prepared.tool.name, error);
  }
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

async function resolveToolObservation(input: {
  toolContext: ToolExecContext;
  callId: string;
  toolName: string;
  result: ToolExecutionResult;
  opts: ToolRoundExecutorOptions;
}): Promise<ToolObservationResult> {
  throwIfAborted(input.toolContext.signal, "Agent run aborted");
  const waitSignal = extractToolWaitSignal(input.result);
  if (!waitSignal || !input.opts.waitForToolResult) {
    try {
      const tool = input.opts.registry.getTool(input.toolName);
      const observationPolicy = tool?.observationPolicy ?? "default";
      const llmFacingResult = await buildLlmFacingToolResult({
        toolContext: input.toolContext,
        toolName: input.toolName,
        result: input.result,
        profile: input.opts.profile,
        provider: input.opts.provider,
        dataRoot: input.opts.dataRoot,
        observationPolicy,
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
  const waitResult = await input.opts.waitForToolResult(waitReq, input.toolContext);
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
