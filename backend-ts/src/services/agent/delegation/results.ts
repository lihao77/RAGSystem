import type { ToolExecutionResult } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "../sdk/tool-results.js";

export interface DelegationRunResult {
  success: boolean;
  content: string;
  summary: string;
  outputType: string;
  metadata: Record<string, unknown>;
}

export function toToolResult(
  toolName: string,
  result: DelegationRunResult,
  metadata: Record<string, unknown>,
): ToolExecutionResult {
  if (!result.success) {
    return toolError(toolName, result.content || result.summary, {
      ...result.metadata,
      ...metadata,
    });
  }
  return toolSuccess(result.content, {
    summary: result.summary,
    outputType: result.outputType,
    metadata: { ...result.metadata, ...metadata },
    toolName,
  });
}

export function summarizeReadinessFailure(
  requirements: Array<{ category: string; satisfied: boolean; message: string }>,
): string {
  const failures = requirements.filter((item) => item.category !== "execution_runtime" && !item.satisfied);
  return failures.length ? failures.map((item) => item.message).join("; ") : "Runtime core configuration is not ready";
}

/** errorResult(message, toolName)——保留旧参数顺序，委托 tool-results。 */
export function errorResult(message: string, toolName: string): ToolExecutionResult {
  return toolError(toolName, message);
}

/** successResult(content, {summary, outputType, metadata, toolName})——委托 tool-results。 */
export function successResult<T>(
  content: T,
  input: {
    summary: string;
    outputType: string;
    metadata: Record<string, unknown>;
    toolName: string;
    llmHint?: string | null;
  },
): ToolExecutionResult {
  return toolSuccess(content, input);
}
