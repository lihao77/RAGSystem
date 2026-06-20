import type { AgentConfig } from "../../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../../contracts/model-adapter.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolExecutor,
  ToolExecutionResult,
  RuntimeToolWaitResult,
} from "../../../runtime/runtime-tool-types.js";
import { isAbortError, throwIfAborted } from "../../../runtime/abort.js";
import { renderToolResultContent } from "../../../runtime/runtime-xml-protocol.js";
import { runToolBatchWithScheduler } from "../../../../tools/scheduler.js";
import { buildLlmFacingToolResult } from "./observation.js";
import {
  buildToolExecutionErrorResult,
  buildToolReferenceErrorResult,
  collectResultPlaceholders,
  collectResultReferenceIndexes,
  materializeToolResult,
  resolveToolArgumentReferences,
} from "./tool-call-utils.js";
import type { PreparedRoundToolCall, RuntimeToolRoundExecution } from "../../kernel/contracts.js";

interface ToolObservationResult {
  success: boolean;
  summary: string;
  observation: string;
  rawResult: Record<string, unknown>;
}

type ToolRoundRuntimeEvent =
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
    };

interface ToolRoundRuntimeInput {
  agent: AgentConfig;
  provider: ModelProviderConfig;
  onEvent?: ((event: ToolRoundRuntimeEvent) => void | Promise<void>) | undefined;
}

export async function executeToolCallRound(input: {
  input: ToolRoundRuntimeInput;
  toolExecutor: RuntimeToolExecutor;
  toolContext: RuntimeToolExecutionContext;
  dataRoot: string;
  round: number;
  calls: PreparedRoundToolCall[];
}): Promise<RuntimeToolRoundExecution[]> {
  const roundResults = new Map<number, ToolExecutionResult>();
  const executions = new Map<number, RuntimeToolRoundExecution>();
  const batches = buildExecutionBatches(input.calls);
  for (const batch of batches) {
    throwIfAborted(input.toolContext.signal, "Agent run aborted");
    const runCall = (call: PreparedRoundToolCall) =>
      executeSingleToolCall({
        input: input.input,
        toolExecutor: input.toolExecutor,
        toolContext: input.toolContext,
        dataRoot: input.dataRoot,
        round: input.round,
        call,
        previousResults: roundResults,
      });
    const batchExecutions = await runToolBatchWithScheduler(batch, {
      signal: input.toolContext.signal,
      classify: (call) => input.toolExecutor.classifyConcurrency?.(
        {
          toolName: call.toolName,
          arguments: resolveToolArgumentReferences(call.arguments, roundResults),
          callId: call.callId,
        },
        buildToolCallExecutionContext(input.toolContext, {
          callId: call.callId,
          round: input.round,
          index: call.index,
        }),
      ) ?? false,
      run: runCall,
    });
    throwIfAborted(input.toolContext.signal, "Agent run aborted");
    for (const execution of batchExecutions) {
      roundResults.set(execution.index + 1, execution.result);
      executions.set(execution.index, execution);
    }
  }
  return [...executions.values()].sort((left, right) => left.index - right.index);
}

async function executeSingleToolCall(input: {
  input: ToolRoundRuntimeInput;
  toolExecutor: RuntimeToolExecutor;
  toolContext: RuntimeToolExecutionContext;
  dataRoot: string;
  round: number;
  call: PreparedRoundToolCall;
  previousResults: Map<number, ToolExecutionResult>;
}): Promise<RuntimeToolRoundExecution> {
  throwIfAborted(input.toolContext.signal, "Agent run aborted");
  const order = input.call.index + 1;
  const toolArguments = resolveToolArgumentReferences(input.call.arguments, input.previousResults);
  await input.input.onEvent?.({
    type: "runtime.tool_call",
    data: {
      agent_name: input.input.agent.agent_name,
      tool_call_id: input.call.callId,
      tool_name: input.call.toolName,
      arguments: toolArguments,
      round: input.round,
      order,
      round_index: order,
    },
  });

  const startedAt = Date.now();
  const unresolvedPlaceholders = collectResultPlaceholders(toolArguments);
  const toolResult = unresolvedPlaceholders.length
    ? buildToolReferenceErrorResult(input.call.toolName, unresolvedPlaceholders)
    : await executeToolSafely({
        toolExecutor: input.toolExecutor,
        toolContext: input.toolContext,
        callId: input.call.callId,
        toolName: input.call.toolName,
        toolArguments,
        round: input.round,
        index: input.call.index,
      });
  throwIfAborted(input.toolContext.signal, "Agent run aborted");
  const observationResult = await resolveToolObservation({
    toolExecutor: input.toolExecutor,
    toolContext: buildToolCallExecutionContext(input.toolContext, {
      callId: input.call.callId,
      round: input.round,
      index: input.call.index,
    }),
    callId: input.call.callId,
    toolName: input.call.toolName,
    result: toolResult,
    agent: input.input.agent,
    provider: input.input.provider,
    dataRoot: input.dataRoot,
  });
  throwIfAborted(input.toolContext.signal, "Agent run aborted");
  const elapsedTime = (Date.now() - startedAt) / 1000;
  await input.input.onEvent?.({
    type: "runtime.tool_result",
    data: {
      agent_name: input.input.agent.agent_name,
      tool_call_id: input.call.callId,
      tool_name: input.call.toolName,
      success: observationResult.success,
      summary: observationResult.summary,
      observation: observationResult.observation,
      metadata: toolResult.metadata,
      raw_result: observationResult.rawResult,
      raw_result_ref: buildRawResultRef(input.toolContext, input.call.callId, input.call.toolName),
      raw_result_available: true,
      elapsed_time: elapsedTime,
      round: input.round,
      order,
      round_index: order,
    },
  });

  return {
    index: input.call.index,
    callId: input.call.callId,
    toolName: input.call.toolName,
    arguments: toolArguments,
    result: toolResult,
    observation: observationResult.observation,
  };
}

function buildExecutionBatches(calls: PreparedRoundToolCall[]): PreparedRoundToolCall[][] {
  const batches: PreparedRoundToolCall[][] = [];
  const completed = new Set<number>();
  let remaining = [...calls];
  while (remaining.length > 0) {
    const batch: PreparedRoundToolCall[] = [];
    const nextRemaining: PreparedRoundToolCall[] = [];
    for (const call of remaining) {
      if (toolCallHasUnmetDependencies(call, completed)) {
        nextRemaining.push(call);
      } else {
        batch.push(call);
      }
    }
    if (batch.length === 0) {
      const [first, ...rest] = remaining;
      if (first) {
        batch.push(first);
      }
      remaining = rest;
    } else {
      remaining = nextRemaining;
    }
    for (const call of batch) {
      completed.add(call.index + 1);
    }
    batches.push(batch);
  }
  return batches;
}

function toolCallHasUnmetDependencies(call: PreparedRoundToolCall, completed: Set<number>): boolean {
  const dependencies = collectResultReferenceIndexes(call.arguments);
  return dependencies.some((index) => !completed.has(index));
}

async function executeToolSafely(input: {
  toolExecutor: RuntimeToolExecutor;
  toolContext: RuntimeToolExecutionContext;
  callId: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  round: number;
  index: number;
}): Promise<ToolExecutionResult> {
  try {
    return await input.toolExecutor.executeTool(
      {
        toolName: input.toolName,
        arguments: input.toolArguments,
        callId: input.callId,
      },
      buildToolCallExecutionContext(input.toolContext, {
        callId: input.callId,
        round: input.round,
        index: input.index,
      }),
    );
  } catch (error) {
    if (isAbortError(error) || input.toolContext.signal?.aborted) {
      throw error;
    }
    return buildToolExecutionErrorResult(input.toolName, error);
  }
}

async function resolveToolObservation(input: {
  toolExecutor: RuntimeToolExecutor;
  toolContext: RuntimeToolExecutionContext;
  callId: string;
  toolName: string;
  result: ToolExecutionResult;
  agent: AgentConfig;
  provider: ModelProviderConfig;
  dataRoot: string;
}): Promise<ToolObservationResult> {
  throwIfAborted(input.toolContext.signal, "Agent run aborted");
  const waitSignal = extractToolWaitSignal(input.result);
  if (!waitSignal || !input.toolExecutor.waitForToolResult) {
    try {
      const llmFacingResult = await buildLlmFacingToolResult(input);
      return {
        success: input.result.success,
        summary: input.result.summary,
        observation: renderToolResultContent({
          callId: input.callId,
          toolName: input.toolName,
          result: llmFacingResult,
        }),
        rawResult: materializeToolResult(input.result),
      };
    } catch (error) {
      if (isAbortError(error) || input.toolContext.signal?.aborted) {
        throw error;
      }
      const errorResult = buildToolExecutionErrorResult(
        input.toolName,
        new Error(`Tool result observation failed: ${error instanceof Error ? error.message : String(error)}`),
      );
      return {
        success: false,
        summary: errorResult.summary,
        observation: renderToolResultContent({
          callId: input.callId,
          toolName: input.toolName,
          result: errorResult,
        }),
        rawResult: materializeToolResult(errorResult),
      };
    }
  }

  const waitResult = await input.toolExecutor.waitForToolResult(
    {
      backgroundTaskId: waitSignal.backgroundTaskId,
      timeoutMs: waitSignal.timeoutMs,
    },
    input.toolContext,
  );
  throwIfAborted(input.toolContext.signal, "Agent run aborted");
  const observation = renderBackgroundWaitObservation(waitResult);
  return {
    success: waitResult.success,
    summary: summarizeBackgroundWaitResult(waitResult),
    observation,
    rawResult: {
      background_notifications: waitResult.payloads,
    },
  };
}

function buildToolCallExecutionContext(
  context: RuntimeToolExecutionContext,
  input: {
    callId: string;
    round: number;
    index: number;
  },
): RuntimeToolExecutionContext {
  const order = input.index + 1;
  return {
    ...context,
    toolCallId: input.callId,
    round: input.round,
    order,
    roundIndex: order,
  };
}

function extractToolWaitSignal(result: ToolExecutionResult): {
  backgroundTaskId: string;
  timeoutMs?: number | null | undefined;
} | null {
  for (const payload of [result.content, result.metadata]) {
    if (!isRecord(payload) || payload.suggest_wait !== true) {
      continue;
    }
    const backgroundTaskId = asNonEmptyString(payload.background_task_id);
    if (!backgroundTaskId) {
      continue;
    }
    return {
      backgroundTaskId,
      timeoutMs: typeof payload.wait_timeout_ms === "number" && Number.isFinite(payload.wait_timeout_ms)
        ? payload.wait_timeout_ms
        : null,
    };
  }
  return null;
}

function renderBackgroundWaitObservation(waitResult: RuntimeToolWaitResult): string {
  return waitResult.payloads
    .map((payload) => renderBackgroundNotification(payload, waitResult.timeout))
    .filter((content) => content.trim())
    .join("\n\n");
}

function renderBackgroundNotification(payload: Record<string, unknown>, timeout: boolean): string {
  const taskId = asNonEmptyString(payload.background_task_id) ?? asNonEmptyString(payload.task_id) ?? "unknown";
  const status = asNonEmptyString(payload.status) ?? (timeout ? "running" : "completed");
  const outputPath = asNonEmptyString(payload.output_path) ?? asNonEmptyString(payload.background_output_path);
  const returnCode = payload.return_code;
  const resultType = asNonEmptyString(payload.result_type);
  const summary = asNonEmptyString(payload.summary) ?? asNonEmptyString(payload.description);
  const parts = ["<task-notification>", `<task-id>${escapeXmlText(taskId)}</task-id>`];
  if (outputPath) {
    parts.push(`<output-file>${escapeXmlText(outputPath)}</output-file>`);
  }
  parts.push(`<status>${escapeXmlText(status)}</status>`);
  if (returnCode !== null && returnCode !== undefined) {
    parts.push(`<return-code>${escapeXmlText(String(returnCode))}</return-code>`);
  }
  if (resultType) {
    parts.push(`<result-type>${escapeXmlText(resultType)}</result-type>`);
  }
  if (summary) {
    parts.push(`<summary>${escapeXmlText(summary)}</summary>`);
  }
  parts.push("</task-notification>");
  return parts.join("\n");
}

function summarizeBackgroundWaitResult(waitResult: RuntimeToolWaitResult): string {
  const summaries = waitResult.payloads
    .map((payload) => asNonEmptyString(payload.summary))
    .filter((summary): summary is string => Boolean(summary));
  if (summaries.length > 0) {
    return summaries.join("\n\n");
  }
  return waitResult.timeout ? "后台任务仍在运行" : "后台任务已完成";
}

function buildRawResultRef(
  context: RuntimeToolExecutionContext,
  callId: string,
  toolName: string,
): Record<string, unknown> {
  return {
    session_id: context.sessionId ?? null,
    call_id: callId,
    tool_name: toolName,
  };
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
