import { toolError } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import type { ToolExecutionResult } from "@ragsystem/agent-sdk";

export interface CodeExecutionInput {
  code: string;
  description?: string | null;
  timeout?: number | null;
}

export interface CodeExecutionPlan {
  code: string;
  description: string;
  timeoutSeconds: number;
  riskLevel: "read_only" | "write";
}

export type CodeExecutionPlanResult =
  | { ok: true; plan: CodeExecutionPlan }
  | { ok: false; result: ToolExecutionResult };

export function prepareCodeExecution(
  input: CodeExecutionInput,
  options: { defaultTimeoutSeconds: number; maxTimeoutSeconds: number },
): CodeExecutionPlanResult {
  if (!input.code.trim()) {
    return { ok: false, result: toolError("execute_code", "代码不能为空") };
  }
  return {
    ok: true,
    plan: {
      code: input.code,
      description: input.description?.trim() ?? "",
      timeoutSeconds: normalizeCodeTimeout(input.timeout, options.defaultTimeoutSeconds, options.maxTimeoutSeconds),
      riskLevel: classifyCodeRisk(input.code),
    },
  };
}

export function normalizeCodeTimeout(
  value: number | null | undefined,
  fallback: number,
  max: number,
): number {
  if (value === null || value === undefined || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, value));
}

function classifyCodeRisk(code: string): "read_only" | "write" {
  const lowered = code.toLowerCase();
  return lowered.includes("call_tool(") || lowered.includes("open(") || lowered.includes("save_file(")
    ? "write"
    : "read_only";
}
