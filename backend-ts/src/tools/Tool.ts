import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { AgentConfig } from "../contracts/agent-config.js";
import type { RiskLevel } from "../contracts/permissions.js";
import type {
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolReturns,
  ToolExecutionResult,
} from "../services/runtime/runtime-tool-types.js";

export type ToolCaller = "direct" | "code_execution" | string;
export type ToolSource = NonNullable<RuntimeToolDefinition["source"]>;

export interface RuntimeToolPermissionResult {
  behavior: "allow" | "deny" | "ask";
  reason?: string | undefined;
  result?: ToolExecutionResult | undefined;
  metadata?: Record<string, unknown> | undefined;
  riskLevel?: RiskLevel | undefined;
  description?: string | undefined;
  arguments?: Record<string, unknown> | undefined;
  approvalType?: string | undefined;
  approvedExternalPaths?: string[] | undefined;
}

export interface RuntimeTool<I = Record<string, unknown>, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: z.ZodType<I> | undefined;
  readonly inputJSONSchema?: Record<string, unknown> | undefined;
  readonly riskLevel?: RiskLevel | undefined;
  readonly allowedCallers: ToolCaller[];
  readonly approvalExempt?: boolean | undefined;
  readonly source?: ToolSource | undefined;
  readonly category?: string | undefined;
  readonly usageContract?: string[] | undefined;
  readonly examples?: unknown[] | undefined;
  readonly extendedUsage?: string | undefined;
  readonly returns?: RuntimeToolReturns | undefined;
  readonly parameters: Record<string, unknown>;
  isVisible(agent: AgentConfig | null): boolean;
  isReadOnly(input: I): boolean;
  isConcurrencySafe(input: I): boolean;
  checkPermissions?(input: I, ctx: RuntimeToolExecutionContext): RuntimeToolPermissionResult;
  call(input: I, ctx: RuntimeToolExecutionContext): Promise<ToolExecutionResult<O>> | ToolExecutionResult<O>;
  getExternalPathApprovalCandidates?(input: I, ctx: RuntimeToolExecutionContext): string[];
}

export interface BuildToolInput<I, O> {
  name: string;
  description: string;
  inputSchema?: z.ZodType<I> | undefined;
  inputJSONSchema?: Record<string, unknown> | undefined;
  parameters?: Record<string, unknown> | undefined;
  riskLevel?: RiskLevel | undefined;
  allowedCallers?: ToolCaller[] | undefined;
  approvalExempt?: boolean | undefined;
  source?: ToolSource | undefined;
  category?: string | undefined;
  usageContract?: string[] | undefined;
  examples?: unknown[] | undefined;
  extendedUsage?: string | undefined;
  returns?: RuntimeToolReturns | undefined;
  isVisible?(agent: AgentConfig | null): boolean;
  isReadOnly?(input: I): boolean;
  isConcurrencySafe?(input: I): boolean;
  checkPermissions?(input: I, ctx: RuntimeToolExecutionContext): RuntimeToolPermissionResult;
  call(input: I, ctx: RuntimeToolExecutionContext): Promise<ToolExecutionResult<O>> | ToolExecutionResult<O>;
  getExternalPathApprovalCandidates?(input: I, ctx: RuntimeToolExecutionContext): string[];
}

export function buildTool<I extends Record<string, unknown>, O = unknown>(
  def: BuildToolInput<I, O>,
): RuntimeTool<I, O> {
  const parameters = def.parameters ?? def.inputJSONSchema ?? (def.inputSchema ? zodObjectToJsonSchema(def.inputSchema) : emptyObjectSchema());
  const tool: RuntimeTool<I, O> = {
    name: def.name,
    description: def.description,
    ...(def.inputSchema ? { inputSchema: def.inputSchema } : {}),
    ...(def.inputJSONSchema ? { inputJSONSchema: def.inputJSONSchema } : {}),
    allowedCallers: def.allowedCallers?.length ? [...def.allowedCallers] : ["direct"],
    parameters,
    isVisible: def.isVisible ?? defaultVisibility(def.name),
    isReadOnly: def.isReadOnly ?? (() => false),
    isConcurrencySafe: def.isConcurrencySafe ?? (() => false),
    call: def.call,
  };
  if (def.riskLevel !== undefined) {
    (tool as MutableRuntimeTool<I, O>).riskLevel = def.riskLevel;
  }
  if (def.approvalExempt !== undefined) {
    (tool as MutableRuntimeTool<I, O>).approvalExempt = def.approvalExempt;
  }
  if (def.source !== undefined) {
    (tool as MutableRuntimeTool<I, O>).source = def.source;
  }
  if (def.category !== undefined) {
    (tool as MutableRuntimeTool<I, O>).category = def.category;
  }
  if (def.usageContract !== undefined) {
    (tool as MutableRuntimeTool<I, O>).usageContract = def.usageContract;
  }
  if (def.examples !== undefined) {
    (tool as MutableRuntimeTool<I, O>).examples = def.examples;
  }
  if (def.extendedUsage !== undefined) {
    (tool as MutableRuntimeTool<I, O>).extendedUsage = def.extendedUsage;
  }
  if (def.returns !== undefined) {
    (tool as MutableRuntimeTool<I, O>).returns = def.returns;
  }
  if (def.checkPermissions !== undefined) {
    (tool as MutableRuntimeTool<I, O>).checkPermissions = def.checkPermissions;
  }
  if (def.getExternalPathApprovalCandidates !== undefined) {
    (tool as MutableRuntimeTool<I, O>).getExternalPathApprovalCandidates = def.getExternalPathApprovalCandidates;
  }
  return tool;
}

type MutableRuntimeTool<I, O> = {
  -readonly [K in keyof RuntimeTool<I, O>]: RuntimeTool<I, O>[K];
};

export function toolToDefinition(tool: RuntimeTool): RuntimeToolDefinition {
  const definition: RuntimeToolDefinition = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
  if (tool.allowedCallers.length) {
    definition.allowed_callers = [...tool.allowedCallers];
  }
  if (tool.returns) {
    definition.returns = tool.returns;
  }
  if (tool.usageContract) {
    definition.usage_contract = [...tool.usageContract];
  }
  if (tool.examples) {
    definition.examples = tool.examples.filter(isRecord);
  }
  if (tool.extendedUsage) {
    definition.extended_usage = tool.extendedUsage;
  }
  if (tool.source) {
    definition.source = tool.source;
  }
  if (tool.category) {
    definition.category = tool.category;
  }
  if (tool.riskLevel) {
    definition.riskLevel = tool.riskLevel;
  }
  if (tool.approvalExempt !== undefined) {
    definition.approvalExempt = tool.approvalExempt;
  }
  return definition;
}

export function defaultVisibility(toolName: string): (agent: AgentConfig | null) => boolean {
  return (agent) => new Set(agent?.tools.enabled_tools ?? []).has(toolName);
}

export function alwaysVisible(): boolean {
  return true;
}

function emptyObjectSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
}

function zodObjectToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  });
  return stripJsonSchemaMeta(jsonSchema as Record<string, unknown>);
}

function stripJsonSchemaMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, definitions: _definitions, ...rest } = schema;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
