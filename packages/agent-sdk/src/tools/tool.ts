/**
 * Tool 富模型——SDK 定义的工具接口、工厂、权限结果类型。
 *
 * Tool 只描述"我能做什么"：定义 + 声明 + 执行。
 * "哪些工具对当前 agent 可见"是消费端的配置决策，不在 Tool 接口上。
 * 消费端在构建 ToolRegistry 时按 agent 配置筛选工具实例。
 */
import type { ToolExecContext, ToolExecutionResult } from "../contracts.js";
import type { ObservationPolicy, RuntimeToolDefinition, RuntimeToolReturns } from "../prompt/tool-types.js";

/* ── 标量类型 ── */

export type RiskLevel = "low" | "medium" | "high";
export type ToolCaller = "direct" | "code_execution" | string;
export type ToolSource = "runtime_builtin" | "memory" | "document" | "execution" | "agent_tool" | "knowledge" | "mcp" | "host";

/* ── InputSchema 鸭子类型（兼容 Zod，SDK 不依赖 Zod 包）── */

export interface InputSchema<I> {
  safeParse(data: unknown):
    | { success: true; data: I }
    | { success: false; error: { message: string; issues?: ReadonlyArray<{ path: ReadonlyArray<string | number>; code: string; message: string }> } };
}

/* ── Tool 访问检查决策（自检 + 审批声明，三态）──
 * action: allow=自检过可放行 / deny=自检失败（可带 result 自定义拒绝结果）/ ask=声明建议审批
 * riskLevel: 风险等级（供审批展示，覆盖 Tool.riskLevel）
 * signals: 自由 shape 业务字段（如 bash_plan/approvalArguments），透传给 handler + 附 input 供 call 读取
 */
export type ToolAccessDecision = (
  | { action: "allow" }
  | { action: "deny"; reason: string; result?: ToolExecutionResult }
  | { action: "ask"; reason: string; description?: string }
) & {
  riskLevel?: string;
  signals?: Record<string, unknown>;
};

/* ── Tool 接口 ── */

export interface Tool<I = Record<string, unknown>, O = unknown> {
  readonly name: string;
  readonly description: string;
  /** 输入校验——鸭子类型兼容 Zod（SDK 不依赖 Zod 包）。 */
  readonly inputSchema?: InputSchema<I>;
  /** JSON Schema 备选（MCP 等无 Zod 的工具用）。 */
  readonly inputJSONSchema?: Record<string, unknown>;
  /** 传给 LLM 的 JSON Schema 参数描述。 */
  readonly parameters: Record<string, unknown>;
  readonly riskLevel?: RiskLevel;
  readonly allowedCallers: ToolCaller[];
  /** 委托宿主执行（true=工具不在后端本地 call，由消费端注入的 delegateToolCall 回调执行）。 */
  readonly delegateToHost?: boolean;
  readonly source?: ToolSource;
  readonly category?: string;
  readonly usageContract?: string[];
  readonly examples?: unknown[];
  readonly extendedUsage?: string;
  readonly returns?: RuntimeToolReturns;
  readonly observationPolicy?: ObservationPolicy;

  /** 输入是否只读（影响并发分类）。 */
  isReadOnly(input: I): boolean;
  /** 输入是否并发安全（需同时 isReadOnly=true 才并发）。 */
  isConcurrencySafe(input: I): boolean;
  /** 工具访问检查（自检 + 审批声明，返回 allow/deny/ask）。 */
  checkAccess?(input: I, ctx: ToolExecContext): ToolAccessDecision;
  /** 实际执行。 */
  call(input: I, ctx: ToolExecContext): ToolExecutionResult | Promise<ToolExecutionResult>;
}

/* ── buildTool 工厂输入 ── */

export interface BuildToolInput<I, O> {
  name: string;
  description: string;
  inputSchema?: InputSchema<I>;
  inputJSONSchema?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  riskLevel?: RiskLevel;
  allowedCallers?: ToolCaller[];
  /** 委托宿主执行。 */
  delegateToHost?: boolean;
  source?: ToolSource;
  category?: string;
  usageContract?: string[];
  examples?: unknown[];
  extendedUsage?: string;
  returns?: RuntimeToolReturns;
  observationPolicy?: ObservationPolicy;
  isReadOnly?(input: I): boolean;
  isConcurrencySafe?(input: I): boolean;
  checkAccess?(input: I, ctx: ToolExecContext): ToolAccessDecision;
  call(input: I, ctx: ToolExecContext): ToolExecutionResult | Promise<ToolExecutionResult>;
}

/* ── buildTool 工厂 ── */

type MutableTool<I, O> = { -readonly [K in keyof Tool<I, O>]: Tool<I, O>[K] };

export function buildTool<I extends Record<string, unknown>, O = unknown>(
  def: BuildToolInput<I, O>,
): Tool<I, O> {
  const parameters = def.parameters ?? def.inputJSONSchema ?? emptyObjectSchema();
  const tool: Tool<I, O> = {
    name: def.name,
    description: def.description,
    ...(def.inputSchema ? { inputSchema: def.inputSchema } : {}),
    ...(def.inputJSONSchema ? { inputJSONSchema: def.inputJSONSchema } : {}),
    allowedCallers: def.allowedCallers?.length ? [...def.allowedCallers] : ["direct"],
    parameters,
    isReadOnly: def.isReadOnly ?? (() => false),
    isConcurrencySafe: def.isConcurrencySafe ?? (() => false),
    call: def.call,
  };
  if (def.riskLevel !== undefined) { (tool as MutableTool<I, O>).riskLevel = def.riskLevel; }
  if (def.delegateToHost !== undefined) { (tool as MutableTool<I, O>).delegateToHost = def.delegateToHost; }
  if (def.source !== undefined) { (tool as MutableTool<I, O>).source = def.source; }
  if (def.category !== undefined) { (tool as MutableTool<I, O>).category = def.category; }
  if (def.usageContract !== undefined) { (tool as MutableTool<I, O>).usageContract = def.usageContract; }
  if (def.examples !== undefined) { (tool as MutableTool<I, O>).examples = def.examples; }
  if (def.extendedUsage !== undefined) { (tool as MutableTool<I, O>).extendedUsage = def.extendedUsage; }
  if (def.returns !== undefined) { (tool as MutableTool<I, O>).returns = def.returns; }
  if (def.observationPolicy !== undefined) { (tool as MutableTool<I, O>).observationPolicy = def.observationPolicy; }
  if (def.checkAccess !== undefined) { (tool as MutableTool<I, O>).checkAccess = def.checkAccess; }
  return tool;
}

/* ── Tool → RuntimeToolDefinition 序列化 ── */

export function toolToDefinition(tool: Tool): RuntimeToolDefinition {
  const definition: RuntimeToolDefinition = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
  if (tool.allowedCallers.length) { definition.allowed_callers = [...tool.allowedCallers]; }
  if (tool.returns) { definition.returns = tool.returns; }
  if (tool.usageContract) { definition.usage_contract = [...tool.usageContract]; }
  if (tool.examples) { definition.examples = tool.examples.filter(isRecord); }
  if (tool.extendedUsage) { definition.extended_usage = tool.extendedUsage; }
  if (tool.source) { definition.source = tool.source; }
  if (tool.category) { definition.category = tool.category; }
  if (tool.riskLevel) { definition.riskLevel = tool.riskLevel; }
  if (tool.observationPolicy) { definition.observationPolicy = tool.observationPolicy; }
  return definition;
}

/* ── 辅助 ── */

function emptyObjectSchema(): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
