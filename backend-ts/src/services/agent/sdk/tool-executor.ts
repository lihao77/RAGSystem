/**
 * ToolExecutor 适配器 —— 把 backend-ts 的 RuntimeToolBridge 适配成 SDK 的 ToolExecutor 端口。
 *
 * 形状适配（三层）：
 *   1. listTools：bridge.listVisibleTools(agent) → SDK RuntimeToolDefinition（去 source/riskLevel/approvalExempt）
 *   2. executeTool：SDK ToolExecContext（最小化标量）+ 绑定的 agent/sessionMetadata →
 *      backend-ts RuntimeToolExecutionContext（含 workspaceRoot/teamName/agent）→ bridge.executeTool
 *   3. 结果映射：snake_case ToolExecutionResult → camelCase（SDK 契约）
 *
 * 为什么 per-run 构造：SDK 的 ToolExecContext 刻意最小化（无 agent/workspaceRoot/teamName），
 * 而工具可见性、workspaceRoot 解析、审批都依赖这些富字段。故适配器在 runtime-adapter 侧
 * 绑定 agent + sessionMetadata，SDK 每次调 executeTool 时只传运行标量，适配器补齐富上下文。
 *
 * approval/hooks/registry 全保留在 bridge 内（不做 observation 渲染——SDK 内部处理）。
 */
import type {
  ToolExecutor,
  ToolExecutorCall,
  ToolExecContext,
  ToolExecutionResult as SdkToolExecutionResult,
  ToolArtifact,
} from "@ragsystem/agent-sdk";
import type { RuntimeToolDefinition as SdkRuntimeToolDefinition } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { RuntimeToolBridge } from "../../runtime/runtime-tool-bridge.js";
import type {
  RuntimeToolCall,
  RuntimeToolExecutionContext,
  RuntimeToolDefinition as BackendToolDefinition,
  ToolExecutionResult as BackendToolExecutionResult,
  RuntimeToolWaitRequest,
  RuntimeToolWaitResult,
} from "../../runtime/runtime-tool-types.js";

export interface SdkToolExecutorOptions {
  /** 现有工具桥（保留 approval/hooks/registry/preparer 全流水线）。 */
  bridge: RuntimeToolBridge;
  /** 当次 run 的 agent 配置（工具可见性 + custom_params.workspace_root）。 */
  agent: AgentConfig;
  /** 当次 session 元数据（team / workspace_root 等富上下文来源）。 */
  sessionMetadata: Record<string, unknown>;
  /** run 级固定字段（不随每次 tool call 变化）。 */
  run: {
    taskId: string;
    requestId: string;
    rootCallId: string;
  };
}

export class SdkToolExecutor implements ToolExecutor {
  constructor(private readonly options: SdkToolExecutorOptions) {}

  listTools(): SdkRuntimeToolDefinition[] {
    return this.options.bridge
      .listVisibleTools(this.options.agent)
      .map(toSdkToolDefinition);
  }

  executeTool(
    call: ToolExecutorCall,
    ctx: ToolExecContext,
  ): SdkToolExecutionResult | Promise<SdkToolExecutionResult> {
    const bridgeCall: RuntimeToolCall = {
      toolName: call.toolName,
      arguments: call.arguments,
      callId: call.callId,
    };
    const execCtx = this.buildExecutionContext(ctx);
    const result = this.options.bridge.executeTool(bridgeCall, execCtx);
    return result instanceof Promise
      ? result.then(toSdkToolResult)
      : toSdkToolResult(result);
  }

  classifyConcurrency(call: ToolExecutorCall, ctx: ToolExecContext): boolean {
    const bridgeCall: RuntimeToolCall = {
      toolName: call.toolName,
      arguments: call.arguments,
      callId: call.callId,
    };
    return this.options.bridge.classifyConcurrency(bridgeCall, this.buildExecutionContext(ctx));
  }

  waitForToolResult(
    request: import("@ragsystem/agent-sdk").ToolWaitRequest,
    ctx: ToolExecContext,
  ): import("@ragsystem/agent-sdk").ToolWaitResult | Promise<import("@ragsystem/agent-sdk").ToolWaitResult> {
    const execCtx = this.buildExecutionContext(ctx);
    const bridgeRequest: RuntimeToolWaitRequest = {
      backgroundTaskId: request.backgroundTaskId,
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    };
    const result = this.options.bridge.waitForToolResult?.(bridgeRequest, execCtx);
    if (result === undefined) {
      return {
        success: false,
        timeout: false,
        payloads: [{ background_task_id: request.backgroundTaskId, status: "missing", success: false }],
      };
    }
    return result instanceof Promise ? result.then(toSdkWaitResult) : toSdkWaitResult(result);
  }

  /**
   * SDK 最小 ToolExecContext + 绑定的 agent/sessionMetadata → backend-ts 富 RuntimeToolExecutionContext。
   * SDK 传来的 ctx.signal / round / order / roundIndex / toolCallId / parentCallId 覆盖绑定默认值。
   */
  private buildExecutionContext(ctx: ToolExecContext): RuntimeToolExecutionContext {
    const { agent, sessionMetadata, run } = this.options;
    return {
      agent,
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      taskId: ctx.taskId ?? run.taskId,
      requestId: ctx.requestId ?? run.requestId,
      currentAgentName: agent.agent_name,
      parentCallId: ctx.parentCallId ?? run.rootCallId,
      toolCallId: ctx.toolCallId,
      round: ctx.round,
      order: ctx.order,
      roundIndex: ctx.roundIndex,
      teamName: asString(sessionMetadata.team),
      workspaceRoot: asString(sessionMetadata.workspace_root) ?? asString(agent.custom_params.workspace_root),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    };
  }
}

/** backend-ts RuntimeToolDefinition → SDK RuntimeToolDefinition（去 source/riskLevel/approvalExempt）。 */
function toSdkToolDefinition(def: BackendToolDefinition): SdkRuntimeToolDefinition {
  const sdk: SdkRuntimeToolDefinition = {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
  };
  if (def.allowed_callers?.length) {
    sdk.allowed_callers = [...def.allowed_callers];
  }
 if (def.returns) {
    sdk.returns = toSdkToolReturns(def.returns);
 }
  if (def.usage_contract?.length) {
    sdk.usage_contract = [...def.usage_contract];
  }
  if (def.examples?.length) {
    sdk.examples = def.examples;
  }
  if (def.extended_usage) {
    sdk.extended_usage = def.extended_usage;
  }
  if (def.category) {
    sdk.category = def.category;
  }
  return sdk;
}

/** snake_case ToolExecutionResult → camelCase（SDK 契约）。 */
/** backend-ts RuntimeToolReturns → SDK RuntimeToolReturns（跨包 exactOptionalPropertyTypes 归一）。 */
function toSdkToolReturns(returns: NonNullable<BackendToolDefinition["returns"]>): NonNullable<SdkRuntimeToolDefinition["returns"]> {
  const sdk: NonNullable<SdkRuntimeToolDefinition["returns"]> = {};
  if (returns.description) {
    sdk.description = returns.description;
  }
  if (returns.shape !== undefined) {
    sdk.shape = returns.shape;
  }
  return sdk;
}

function toSdkToolResult(result: BackendToolExecutionResult): SdkToolExecutionResult {
  const sdk: SdkToolExecutionResult = {
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
  return sdk;
}

/** backend-ts artifacts（结构松散）→ SDK ToolArtifact[]（结构化）。 */
function toSdkArtifacts(artifacts: unknown[]): ToolArtifact[] {
  if (!Array.isArray(artifacts)) {
    return [];
  }
  return artifacts
    .map((item) => toSdkArtifact(item))
    .filter((artifact): artifact is ToolArtifact => artifact !== null);
}

function toSdkArtifact(item: unknown): ToolArtifact | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const record = item as Record<string, unknown>;
  const artifactType = record.artifactType ?? record.artifact_type;
  if (artifactType !== "json" && artifactType !== "text") {
    return null;
  }
  const path = asString(record.path);
  if (!path) {
    return null;
  }
  return {
    artifactType,
    path,
    mimeType: asString(record.mimeType ?? record.mime_type) ?? "text/plain",
    size: asNumber(record.size) ?? 0,
    metadata: isRecord(record.metadata) ? record.metadata : {},
  };
}

/** backend-ts RuntimeToolWaitResult → SDK ToolWaitResult（字段同构）。 */
function toSdkWaitResult(result: RuntimeToolWaitResult): import("@ragsystem/agent-sdk").ToolWaitResult {
  return {
    success: result.success,
    timeout: result.timeout,
    payloads: result.payloads,
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
