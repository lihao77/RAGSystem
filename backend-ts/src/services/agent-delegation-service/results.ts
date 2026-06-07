import type { ToolExecutionResult } from "../memory-tool-service.js";

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
    return {
      ...errorResult(result.content || result.summary, toolName),
      metadata: {
        ...result.metadata,
        ...metadata,
        source_shape: "error",
      },
    };
  }
  return successResult(result.content, {
    summary: result.summary,
    outputType: result.outputType,
    metadata: {
      ...result.metadata,
      ...metadata,
    },
    toolName,
  });
}

export function summarizeReadinessFailure(
  requirements: Array<{ category: string; satisfied: boolean; message: string }>,
): string {
  const failures = requirements.filter((item) => item.category !== "execution_runtime" && !item.satisfied);
  return failures.length ? failures.map((item) => item.message).join("; ") : "Runtime core configuration is not ready";
}

export function successResult<T>(
  content: T,
  input: {
    summary: string;
    outputType: string;
    metadata: Record<string, unknown>;
    toolName: string;
    llmHint?: string | null;
  },
): ToolExecutionResult<T> {
  return {
    success: true,
    tool_name: input.toolName,
    summary: input.summary,
    answer: null,
    output_type: input.outputType,
    content,
    metadata: input.metadata,
    artifacts: [],
    llm_hint: input.llmHint ?? null,
  };
}

export function errorResult(message: string, toolName: string): ToolExecutionResult<string> {
  return {
    success: false,
    tool_name: toolName,
    summary: message,
    answer: null,
    output_type: "error",
    content: message,
    metadata: {
      source_shape: "error",
    },
    artifacts: [],
    llm_hint: null,
  };
}
