import { z } from "zod";

import type { RuntimeToolCall, ToolExecutionResult } from "../runtime-tool-types.js";
import type { RuntimeTool } from "./tool.js";

export interface RuntimeToolValidationSuccess<I> {
  ok: true;
  input: I;
}

export interface RuntimeToolValidationFailure {
  ok: false;
  result: ToolExecutionResult<string>;
}

export type RuntimeToolValidationResult<I> = RuntimeToolValidationSuccess<I> | RuntimeToolValidationFailure;

export function validateToolInput<I extends Record<string, unknown>>(
  tool: RuntimeTool<I>,
  call: RuntimeToolCall,
): RuntimeToolValidationResult<I> {
  if (!tool.inputSchema) {
    return { ok: true, input: (call.arguments ?? {}) as I };
  }
  const parsed = tool.inputSchema.safeParse(call.arguments ?? {});
  if (parsed.success) {
    return { ok: true, input: parsed.data };
  }
  return {
    ok: false,
    result: inputValidationErrorResult(tool.name, parsed.error),
  };
}

export function inputValidationErrorResult(toolName: string, error: z.ZodError): ToolExecutionResult<string> {
  const issues = error.issues.map(formatIssue);
  const summary = `工具 ${toolName} 输入参数校验失败: ${issues.join("; ")}`;
  return {
    success: false,
    tool_name: toolName,
    summary,
    answer: null,
    output_type: "error",
    content: summary,
    metadata: {
      source_shape: "error",
      error_type: "InputValidationError",
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    },
    artifacts: [],
    llm_hint: "请按工具参数 schema 修正参数后重试，不要原样重复失败调用。",
  };
}

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.length ? issue.path.join(".") : "<root>";
  return `${path}: ${issue.message}`;
}
