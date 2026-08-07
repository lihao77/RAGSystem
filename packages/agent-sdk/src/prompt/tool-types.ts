/**
 * 工具定义类型（解耦 backend-ts RuntimeToolDefinition 核心字段）。
 * 设计稿 §2：调用方传已解析的 tools 实例，SDK 只用这些字段渲染 prompt。
 */
export interface RuntimeToolReturns {
  description?: string;
  shape?: unknown;
}

export type RuntimeToolExample = Record<string, unknown>;

/**
 * 工具自声明的 observation 策略，决定结果如何回喂模型。
 * - default：走 SDK 大小决策（超限落盘临时文件）
 * - inline：工具声明结果必须完整 inline，不落盘（如 read_file 已自带分页、技能文档需即时阅读）
 */
export type ObservationPolicy = "default" | "inline";

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
  observationPolicy?: ObservationPolicy;
}
