/**
 * 工具定义类型（解耦 backend-ts RuntimeToolDefinition 核心字段）。
 * 设计稿 §2：调用方传已解析的 tools 实例，SDK 只用这些字段渲染 prompt。
 */
export interface RuntimeToolReturns {
  description?: string;
  shape?: unknown;
}

export type RuntimeToolExample = Record<string, unknown>;

export interface RuntimeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  allowed_callers?: Array<"direct" | "code_execution" | string>;
  returns?: RuntimeToolReturns;
  usage_contract?: string[];
  examples?: RuntimeToolExample[];
  extended_usage?: string;
  category?: string;
  source?: "runtime_builtin" | "memory" | "document" | "execution" | "agent_tool" | "knowledge" | "mcp";
  riskLevel?: "low" | "medium" | "high";
  approvalExempt?: boolean;
}
