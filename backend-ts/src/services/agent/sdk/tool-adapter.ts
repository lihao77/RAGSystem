/**
 * backend-ts RuntimeTool → SDK Tool 适配器。
 *
 * 过渡层：把 backend-ts 的 RuntimeTool（依赖 AgentConfig/RuntimeToolExecutionContext）
 * 包装成 SDK 的 Tool（依赖 AgentProfile/ToolExecContext）。
 *
 * 每个 backend-ts 工具文件仍用 backend-ts 的 buildTool 构造 RuntimeTool，
 * 本适配器在 runtime 组装时统一转换。后续逐个工具迁移后本文件删除。
 */
import type {
  Tool,
  ToolPermissionResult,
  RiskLevel as SdkRiskLevel,
  ToolCaller as SdkToolCaller,
  ToolSource as SdkToolSource,
} from "@ragsystem/agent-sdk";
import type { ToolExecContext, ToolExecutionResult as SdkToolExecutionResult, ToolWaitRequest, ToolWaitResult } from "@ragsystem/agent-sdk";
import type { ToolRegistry } from "@ragsystem/agent-sdk";
import { createToolRegistry } from "@ragsystem/agent-sdk";
import type { RuntimeTool, RuntimeToolPermissionResult } from "../../../tools/Tool.js";
import type { RuntimeToolExecutionContext, ToolExecutionResult as BackendToolExecutionResult } from "../../runtime/runtime-tool-types.js";
import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { RuntimeToolRegistry } from "../../../tools/registry.js";

/* ── RuntimeTool → SDK Tool 适配 ── */

export interface ToolAdapterOptions {
  /** 当次 run 的 agent 配置（backend-ts 工具 isVisible/call/checkPermissions 需要）。 */
  agent: AgentConfig;
  /** session 元数据（team / workspace_root 等富上下文来源）。 */
  sessionMetadata: Record<string, unknown>;
  /** run 级固定字段。 */
  run: { taskId: string; requestId: string; rootCallId: string };
}

/**
 * 把 backend-ts RuntimeTool 包装成 SDK Tool。
 *
 * 关键适配：
 * - isVisible(profile) → backend-ts tool.isVisible(agent)（闭包捕获 agent）
 * - call(input, ctx) → backend-ts tool.call(input, backendCtx)（ToolExecContext → RuntimeToolExecutionContext）
 * - ToolExecutionResult snake_case → camelCase
 */
export function adaptRuntimeTool(
  backendTool: RuntimeTool,
  opts: ToolAdapterOptions,
): Tool {
  const tool: Tool = {
    name: backendTool.name,
    description: backendTool.description,
    ...(backendTool.inputSchema ? { inputSchema: backendTool.inputSchema } : {}),
    ...(backendTool.inputJSONSchema ? { inputJSONSchema: backendTool.inputJSONSchema } : {}),
    parameters: backendTool.parameters,
    allowedCallers: [...backendTool.allowedCallers] as SdkToolCaller[],
    isReadOnly: (input) => backendTool.isReadOnly(input),
    isConcurrencySafe: (input) => backendTool.isConcurrencySafe(input),
    call: (input, ctx) => {
      const backendCtx = toBackendContext(ctx, opts);
      const result = backendTool.call(input, backendCtx);
      return result instanceof Promise
        ? result.then(toSdkToolResult)
        : toSdkToolResult(result);
    },
  };
  // 可选字段——逐个赋值避免 exactOptionalPropertyTypes 问题
  if (backendTool.riskLevel !== undefined) {
    (tool as Mutable).riskLevel = backendTool.riskLevel as SdkRiskLevel;
  }
  if (backendTool.approvalExempt !== undefined) {
    (tool as Mutable).approvalExempt = backendTool.approvalExempt;
  }
  if (backendTool.source !== undefined) {
    (tool as Mutable).source = backendTool.source as SdkToolSource;
  }
  if (backendTool.category !== undefined) {
    (tool as Mutable).category = backendTool.category;
  }
  if (backendTool.usageContract !== undefined) {
    (tool as Mutable).usageContract = backendTool.usageContract;
  }
  if (backendTool.examples !== undefined) {
    (tool as Mutable).examples = backendTool.examples;
  }
  if (backendTool.extendedUsage !== undefined) {
    (tool as Mutable).extendedUsage = backendTool.extendedUsage;
  }
  if (backendTool.returns !== undefined) {
    const sdkReturns: NonNullable<Tool["returns"]> = {};
    if (backendTool.returns.description) { sdkReturns.description = backendTool.returns.description; }
    if (backendTool.returns.shape !== undefined) { sdkReturns.shape = backendTool.returns.shape; }
    (tool as Mutable).returns = sdkReturns;
  }
  if (backendTool.checkPermissions) {
    const originalCheck = backendTool.checkPermissions.bind(backendTool);
    (tool as Mutable).checkPermissions = (input: Record<string, unknown>, ctx: ToolExecContext): ToolPermissionResult => {
      const backendCtx = toBackendContext(ctx, opts);
      const result = originalCheck(input, backendCtx);
      return toSdkPermissionResult(result);
    };
  }
  if (backendTool.getExternalPathApprovalCandidates) {
    const originalCandidates = backendTool.getExternalPathApprovalCandidates.bind(backendTool);
    (tool as Mutable).getExternalPathApprovalCandidates = (input: Record<string, unknown>, ctx: ToolExecContext): string[] => {
      const backendCtx = toBackendContext(ctx, opts);
      return originalCandidates(input, backendCtx);
    };
  }
  return tool;
}

type Mutable = { -readonly [K in keyof Tool]: Tool[K] };

/**
 * 从 backend-ts RuntimeToolRegistry 构建 SDK ToolRegistry。
 *
 * backend-ts registry.listTools(agent) 已完成 isVisible 过滤（含 MCP 动态工具），
 * 适配后的 SDK Tool[] 直接注册进纯容器 ToolRegistry——不再需要 isVisible。
 */
export function buildSdkToolRegistry(
  backendRegistry: RuntimeToolRegistry,
  opts: ToolAdapterOptions,
): ToolRegistry {
  const allBackendTools = backendRegistry.listTools(opts.agent);
  const tools = allBackendTools.map((t) => adaptRuntimeTool(t, opts));
  return createToolRegistry({ tools });
}

/* ── 后台任务等待——从 backend-ts TaskToolService 适配 ── */

export interface WaitForToolResultAdapter {
  (request: ToolWaitRequest, ctx: ToolExecContext): ToolWaitResult | Promise<ToolWaitResult>;
}

export function createWaitForToolResultAdapter(
  taskTools: import("../../../tools/TaskTools/TaskExecution.js").TaskToolService | null,
): WaitForToolResultAdapter | undefined {
  if (!taskTools) { return undefined; }
  return (request, ctx) => {
    return taskTools.waitForBackgroundTask({
      taskId: request.backgroundTaskId,
      timeoutMs: request.timeoutMs,
      signal: ctx.signal,
    });
  };
}

/* ── 类型转换辅助 ── */

function toBackendContext(ctx: ToolExecContext, opts: ToolAdapterOptions): RuntimeToolExecutionContext {
  const { agent, sessionMetadata, run } = opts;
  return {
    agent,
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    taskId: ctx.taskId ?? run.taskId,
    requestId: ctx.requestId ?? run.requestId,
    currentAgentName: ctx.currentAgentName ?? agent.agent_name,
    parentCallId: ctx.parentCallId ?? run.rootCallId,
    toolCallId: ctx.toolCallId,
    round: ctx.round,
    order: ctx.order,
    roundIndex: ctx.roundIndex,
    ...(ctx.caller ? { caller: ctx.caller } : {}),
    teamName: asString(sessionMetadata.team),
    workspaceRoot: ctx.workspaceRoot ?? asString(sessionMetadata.workspace_root) ?? asString(agent.custom_params.workspace_root),
    ...(ctx.approvedExternalPaths?.length ? { approvedExternalPaths: ctx.approvedExternalPaths } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

function toSdkToolResult(result: BackendToolExecutionResult): SdkToolExecutionResult {
  return {
    success: result.success,
    toolName: result.tool_name,
    summary: result.summary,
    answer: result.answer,
    outputType: result.output_type,
    content: result.content,
    metadata: result.metadata,
    artifacts: toSdkArtifacts(result.artifacts),
    llmHint: result.llm_hint,
  };
}

function toSdkPermissionResult(result: RuntimeToolPermissionResult): ToolPermissionResult {
  const sdk: ToolPermissionResult = {
    behavior: result.behavior,
  };
  if (result.reason !== undefined) { sdk.reason = result.reason; }
  if (result.result !== undefined) { sdk.result = toSdkToolResult(result.result); }
  if (result.metadata !== undefined) { sdk.metadata = result.metadata; }
  if (result.riskLevel !== undefined) { sdk.riskLevel = result.riskLevel as SdkRiskLevel; }
  if (result.description !== undefined) { sdk.description = result.description; }
  if (result.arguments !== undefined) { sdk.arguments = result.arguments; }
  if (result.approvalType !== undefined) { sdk.approvalType = result.approvalType; }
  if (result.approvedExternalPaths !== undefined) { sdk.approvedExternalPaths = result.approvedExternalPaths; }
  return sdk;
}

function toSdkArtifacts(artifacts: unknown[]): SdkToolExecutionResult["artifacts"] {
  if (!Array.isArray(artifacts)) { return []; }
  return artifacts.map(toSdkArtifact).filter((a): a is NonNullable<typeof a> => a !== null);
}

function toSdkArtifact(item: unknown): import("@ragsystem/agent-sdk").ToolArtifact | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) { return null; }
  const record = item as Record<string, unknown>;
  const artifactType = record.artifactType ?? record.artifact_type;
  if (artifactType !== "json" && artifactType !== "text") { return null; }
  const path = asString(record.path);
  if (!path) { return null; }
  return {
    artifactType,
    path,
    mimeType: asString(record.mimeType ?? record.mime_type) ?? "text/plain",
    size: asNumber(record.size) ?? 0,
    metadata: isRecord(record.metadata) ? record.metadata : {},
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
