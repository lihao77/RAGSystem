/**
 * 工具输入校验——鸭子类型 InputSchema.safeParse，SDK 不依赖 Zod。
 */
import type { ToolExecutionResult } from "../contracts.js";
import type { Tool } from "./tool.js";

export interface ToolValidationSuccess<I> {
  ok: true;
  input: I;
}

export interface ToolValidationFailure {
  ok: false;
  result: ToolExecutionResult;
}

export type ToolValidationResult<I> = ToolValidationSuccess<I> | ToolValidationFailure;

export function validateToolInput<I extends Record<string, unknown>>(
  tool: Tool<I>,
  args: Record<string, unknown>,
): ToolValidationResult<I> {
  if (!tool.inputSchema) {
    return { ok: true, input: args as I };
  }
  const parsed = tool.inputSchema.safeParse(args);
  if (parsed.success) {
    return { ok: true, input: parsed.data };
  }
  return { ok: false, result: inputValidationErrorResult(tool.name, parsed.error) };
}

function inputValidationErrorResult(
  toolName: string,
  error: { message: string; issues?: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: string; message: string }> },
): ToolExecutionResult {
  const issues = error.issues
    ? error.issues.map((issue) => `${issue.path.length ? formatIssuePath(issue.path) : "<root>"}: ${issue.message}`)
    : [error.message];
  const summary = `工具 ${toolName} 输入参数校验失败: ${issues.join("; ")}`;
  return {
    success: false,
    toolName,
    summary,
    answer: null,
    outputType: "error",
    content: summary,
    metadata: {
      source_shape: "error",
      error_type: "InputValidationError",
      ...(error.issues
        ? { issues: error.issues.map((issue) => ({ path: formatIssuePath(issue.path), code: issue.code, message: issue.message })) }
        : {}),
    },
    artifacts: [],
    llmHint: "请按工具参数 schema 修正参数后重试，不要原样重复失败调用。",
  };
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.map(String).join(".");
}
