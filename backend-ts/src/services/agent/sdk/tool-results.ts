/**
 * 工具结果构造辅助——SDK camelCase ToolExecutionResult。
 *
 * 所有工具/service 用这俩替代旧的 snake_case errorResult/successResult。
 * 对齐 @ragsystem/agent-sdk 的 ToolExecutionResult 形状。
 */
import type { ToolExecutionResult } from "@ragsystem/agent-sdk";

export function toolSuccess<T>(
  content: T,
  input: {
    toolName: string;
    summary: string;
    outputType: string;
    metadata?: Record<string, unknown>;
  },
): ToolExecutionResult {
  return {
    success: true,
    toolName: input.toolName,
    summary: input.summary,
    answer: null,
    outputType: input.outputType,
    content,
    metadata: input.metadata ?? {},
    artifacts: [],
    llmHint: null,
  };
}

export function toolError(
  toolName: string,
  message: string,
  metadata: Record<string, unknown> = {},
): ToolExecutionResult {
  return {
    success: false,
    toolName,
    summary: message,
    answer: null,
    outputType: "error",
    content: message,
    metadata: {
      source_shape: "error",
      ...metadata,
    },
    artifacts: [],
    llmHint: null,
  };
}
