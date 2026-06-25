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
export type ToolSource = "runtime_builtin" | "memory" | "document" | "execution" | "agent_tool" | "knowledge" | "mcp";

/* ── InputSchema 鸭子类型（兼容 Zod，SDK 不依赖 Zod 包）── */

export interface InputSchema<I> {
  safeParse(data: unknown):
    | { success: true; data: I }
    | { success: false; error: { message: string; issues?: ReadonlyArray<{ path: ReadonlyArray<string | number>; code: string; message: string }> } };
}

/* ── Tool 权限自检结果 ── */

export interface ToolPermissionResult {
  behavior: "allow" | "deny" | "ask";
  reason?: string;
  result?: ToolExecutionResult;
  metadata?: Record<string, unknown>;
  riskLevel?: RiskLevel;
  description?: string;
  arguments?: Record<string, unknown>;
  approvalType?: string;
  approvedExternalPaths?: string[];
}

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
  readonly approvalExempt?: boolean;
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
  /** 工具级权限自检（可选，返回 deny/allow/ask + 覆盖 riskLevel/arguments）。 */
  checkPermissions?(input: I, ctx: ToolExecContext): ToolPermissionResult;
  /** 实际执行。 */
  call(input: I, ctx: ToolExecContext): ToolExecutionResult | Promise<ToolExecutionResult>;
  /** 收集需审批的外部路径候选（文件访问等）。 */
  getExternalPathApprovalCandidates?(input: I, ctx: ToolExecContext): string[];
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
  approvalExempt?: boolean;
  source?: ToolSource;
  category?: string;
  usageContract?: string[];
  examples?: unknown[];
  extendedUsage?: string;
  returns?: RuntimeToolReturns;
  observationPolicy?: ObservationPolicy;
  isReadOnly?(input: I): boolean;
  isConcurrencySafe?(input: I): boolean;
  checkPermissions?(input: I, ctx: ToolExecContext): ToolPermissionResult;
  call(input: I, ctx: ToolExecContext): ToolExecutionResult | Promise<ToolExecutionResult>;
  getExternalPathApprovalCandidates?(input: I, ctx: ToolExecContext): string[];
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
  if (def.approvalExempt !== undefined) { (tool as MutableTool<I, O>).approvalExempt = def.approvalExempt; }
  if (def.source !== undefined) { (tool as MutableTool<I, O>).source = def.source; }
  if (def.category !== undefined) { (tool as MutableTool<I, O>).category = def.category; }
  if (def.usageContract !== undefined) { (tool as MutableTool<I, O>).usageContract = def.usageContract; }
  if (def.examples !== undefined) { (tool as MutableTool<I, O>).examples = def.examples; }
  if (def.extendedUsage !== undefined) { (tool as MutableTool<I, O>).extendedUsage = def.extendedUsage; }
  if (def.returns !== undefined) { (tool as MutableTool<I, O>).returns = def.returns; }
  if (def.observationPolicy !== undefined) { (tool as MutableTool<I, O>).observationPolicy = def.observationPolicy; }
  if (def.checkPermissions !== undefined) { (tool as MutableTool<I, O>).checkPermissions = def.checkPermissions; }
  if (def.getExternalPathApprovalCandidates !== undefined) { (tool as MutableTool<I, O>).getExternalPathApprovalCandidates = def.getExternalPathApprovalCandidates; }
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
  if (tool.approvalExempt !== undefined) { definition.approvalExempt = tool.approvalExempt; }
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
