import type { AgentConfig } from "../../contracts/agent-config.js";
import type { MemoryToolService } from "../tools/memory-tool-service.js";
import type { LocalDocumentToolService } from "../tools/local-document-tool-service.js";
import type { CodeExecutionToolService } from "../tools/code-execution-tool-service.js";
import type { AgentDelegationService } from "../agent/agent-delegation-service.js";
import type { TaskToolService } from "../tools/task-tool-service.js";
import type { LocalSearchToolService } from "../tools/local-search-tool-service.js";
import type { SkillToolService } from "../tools/skill-tool-service.js";
import type { VectorLibraryService } from "../knowledge/vector-library-service.js";
import type { McpService } from "../integrations/mcp-service.js";
import type { LocalBashToolService } from "../tools/local-bash-tool-service.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolExecutor,
  ToolExecutionResult,
  RuntimeToolWaitRequest,
  RuntimeToolWaitResult,
} from "./runtime-tool-types.js";
import type { PendingInteractionService } from "./pending-interaction-service.js";
import type {
  PermissionPolicyService,
  RuntimeToolApprovalDecision,
} from "./permission-policy-service.js";
import { isAbortError, throwIfAborted } from "./abort.js";
import type { HookRuntimeService, HookResult } from "./hooks/index.js";
import {
  approvalUnsupportedError,
  buildApprovalMetadata,
  buildToolCallContext,
  dedupeStrings,
  errorResult,
  withApprovalMetadata,
  withApprovedExternalPaths,
} from "./runtime-tool-bridge/arguments.js";
import { createToolRegistry, type RuntimeToolRegistry } from "./tools/tool-registry.js";
import { toolToDefinition, type RuntimeTool, type RuntimeToolPermissionResult } from "./tools/tool.js";
import { validateToolInput } from "./tools/validation.js";
import {
  applyHookPermissionDecision,
  denyPermissionResult,
  isToolPermissionForceAsk,
  mergeToolPermissionMetadata,
} from "./tools/tool-permissions.js";

export { isReadOnlyMemoryToolName } from "./runtime-tool-bridge/arguments.js";

type PreparedRuntimeTool = {
  call: RuntimeToolCall;
  context: RuntimeToolExecutionContext;
  toolName: string;
  tool: RuntimeTool<Record<string, unknown>>;
  input: Record<string, unknown>;
  caller: string;
  toolPermission: RuntimeToolPermissionResult | null;
  approvedExternalPaths: string[];
};

type PreparedResult = PreparedRuntimeTool | ToolExecutionResult;

export class RuntimeToolBridge implements RuntimeToolExecutor {
  private agentDelegation: AgentDelegationService | null = null;
  private readonly toolRegistry: RuntimeToolRegistry;

  constructor(
    memoryTools: MemoryToolService,
    private readonly pendingInteractions: PendingInteractionService | null = null,
    private readonly permissionPolicy: PermissionPolicyService | null = null,
    documentTools: LocalDocumentToolService | null = null,
    bashTools: LocalBashToolService | null = null,
    private readonly taskTools: TaskToolService | null = null,
    searchTools: LocalSearchToolService | null = null,
    private readonly hooks: HookRuntimeService | null = null,
    vectorLibrary: VectorLibraryService | null = null,
    mcp: McpService | null = null,
    codeExecutionTools: CodeExecutionToolService | null = null,
    skillTools: SkillToolService | null = null,
  ) {
    this.toolRegistry = createToolRegistry({
      memoryTools,
      pendingInteractions,
      documentTools,
      bashTools,
      taskTools,
      searchTools,
      vectorLibrary,
      mcp,
      codeExecutionTools,
      skillTools,
      getAgentDelegation: () => this.agentDelegation,
    });
  }

  setAgentDelegation(agentDelegation: AgentDelegationService | null): void {
    this.agentDelegation = agentDelegation;
  }

  listVisibleTools(agent: AgentConfig | null): RuntimeToolDefinition[] {
    return this.toolRegistry.listDefinitions(agent);
  }

  listVisibleToolNames(agent: AgentConfig | null): string[] {
    return this.listVisibleTools(agent).map((tool) => tool.name);
  }

  canExecuteTool(toolName: string, agent: AgentConfig | null): boolean {
    return this.listVisibleToolNames(agent).includes(toolName);
  }

  classifyConcurrency(call: RuntimeToolCall, context: RuntimeToolExecutionContext): boolean {
    return this.toolRegistry.classifyConcurrency(call, context);
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext): ToolExecutionResult | Promise<ToolExecutionResult> {
    throwIfAborted(context.signal, "Tool execution aborted");
    const prepared = this.prepareToolExecution(call, context);
    if (isToolResult(prepared)) {
      return prepared;
    }
    if (this.hooks) {
      return this.executePreparedToolWithPermissionHooks(prepared);
    }
    const approval = this.evaluateApproval(prepared);
    if (isToolResult(approval)) {
      return approval;
    }
    if (approval?.action === "ask") {
      return this.executeToolAfterApproval(prepared, approval, false);
    }
    return this.executePreparedTool(
      prepared,
      withApprovedExternalPaths(prepared.context, approval?.approvedExternalPaths),
    );
  }

  waitForToolResult(
    request: RuntimeToolWaitRequest,
    context: RuntimeToolExecutionContext,
  ): RuntimeToolWaitResult | Promise<RuntimeToolWaitResult> {
    if (!this.taskTools) {
      return {
        success: false,
        timeout: false,
        payloads: [
          {
            task_id: request.backgroundTaskId,
            background_task_id: request.backgroundTaskId,
            status: "missing",
            success: false,
            summary: `后台任务 ${request.backgroundTaskId} 不存在`,
          },
        ],
      };
    }
    return this.taskTools.waitForBackgroundTask({
      taskId: request.backgroundTaskId,
      timeoutMs: request.timeoutMs,
      signal: context.signal,
    });
  }

  private prepareToolExecution(call: RuntimeToolCall, context: RuntimeToolExecutionContext): PreparedResult {
    const executionContext = buildToolCallContext(call, {
      ...context,
      caller: context.caller ?? "direct",
    });
    const toolName = call.toolName.trim();
    const tool = this.toolRegistry.getVisibleTool(toolName, executionContext.agent) as RuntimeTool<Record<string, unknown>> | null;
    if (!tool) {
      return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName || "unknown");
    }

    const caller = executionContext.caller ?? "direct";
    if (!tool.allowedCallers.includes(caller)) {
      return errorResult(
        `工具 '${toolName}' 不允许从${caller === "code_execution" ? "代码" : caller}调用: Tool ${toolName} is not allowed from caller ${caller}`,
        toolName,
      );
    }

    const validation = validateToolInput(tool, call);
    if (!validation.ok) {
      return validation.result;
    }

    const toolPermission = tool.checkPermissions?.(validation.input, executionContext) ?? null;
    if (toolPermission?.behavior === "deny") {
      return toolPermission.result ?? denyPermissionResult(toolName, toolPermission);
    }
    attachPermissionRuntimeData(validation.input, toolPermission);

    const approvedExternalPaths = dedupeStrings([
      ...(tool.getExternalPathApprovalCandidates?.(validation.input, executionContext) ?? []),
      ...(toolPermission?.approvedExternalPaths ?? []),
    ]);

    return {
      call,
      context: executionContext,
      toolName,
      tool,
      input: validation.input,
      caller,
      toolPermission,
      approvedExternalPaths,
    };
  }

  private async executePreparedToolWithPermissionHooks(prepared: PreparedRuntimeTool): Promise<ToolExecutionResult> {
    const beforePermissionHook = await this.runToolHook("tool.before_permission", {
      toolName: prepared.toolName,
      tool: toolToDefinition(prepared.tool),
      call: prepared.call,
      context: prepared.context,
    });
    if (beforePermissionHook.blockExecution || beforePermissionHook.permissionDecision === "deny") {
      return this.hookBlockedResult(prepared.toolName, beforePermissionHook, "before_permission");
    }

    const approval = this.evaluateApproval(prepared, beforePermissionHook);
    if (isToolResult(approval)) {
      return approval;
    }
    const afterPermissionHook = await this.runToolHook("tool.after_permission", {
      toolName: prepared.toolName,
      tool: toolToDefinition(prepared.tool),
      call: prepared.call,
      context: prepared.context,
      permissionDecision: approval ?? null,
    });
    if (afterPermissionHook.blockExecution || afterPermissionHook.permissionDecision === "deny") {
      return this.hookBlockedResult(prepared.toolName, afterPermissionHook, "after_permission");
    }
    const finalApproval = applyHookPermissionDecision(
      approval,
      afterPermissionHook,
      prepared.toolName,
      prepared.toolPermission?.riskLevel ?? prepared.tool.riskLevel,
    );
    if (finalApproval?.action === "ask") {
      return this.executeToolAfterApproval(prepared, finalApproval, true, {
        beforePermissionHook,
        afterPermissionHook,
      });
    }

    return this.executePreparedToolWithHooks(
      prepared,
      withApprovedExternalPaths(prepared.context, finalApproval?.approvedExternalPaths),
      { beforePermissionHook, afterPermissionHook },
    );
  }

  private evaluateApproval(
    prepared: PreparedRuntimeTool,
    hookResult?: HookResult | undefined,
  ): RuntimeToolApprovalDecision | ToolExecutionResult | undefined {
    if (!this.permissionPolicy) {
      if (prepared.approvedExternalPaths.length) {
        return approvalUnsupportedError(prepared.toolName, prepared.approvedExternalPaths);
      }
      if (isToolPermissionForceAsk(prepared.toolPermission)) {
        return errorResult(`工具 ${prepared.toolName} 需要用户授权，但当前上下文不支持审批`, prepared.toolName, {
          ...mergeToolPermissionMetadata({}, prepared.toolPermission),
        });
      }
      return undefined;
    }

    const decision = this.permissionPolicy.evaluateToolApproval({
      toolName: prepared.toolName,
      riskLevel: prepared.toolPermission?.riskLevel ?? prepared.tool.riskLevel,
      description: prepared.toolPermission?.description ?? prepared.tool.description,
      arguments: this.approvalArguments(prepared),
      sessionId: prepared.context.sessionId,
      approvalExempt: prepared.tool.approvalExempt,
      forceAsk: isToolPermissionForceAsk(prepared.toolPermission),
      approvedExternalPaths: prepared.approvedExternalPaths,
    });
    return hookResult
      ? applyHookPermissionDecision(
          decision,
          hookResult,
          prepared.toolName,
          prepared.toolPermission?.riskLevel ?? prepared.tool.riskLevel,
        )
      : decision;
  }

  private executePreparedTool(
    prepared: PreparedRuntimeTool,
    context: RuntimeToolExecutionContext,
  ): ToolExecutionResult | Promise<ToolExecutionResult> {
    throwIfAborted(context.signal, "Tool execution aborted");
    return prepared.tool.call(prepared.input, context);
  }

  private async executePreparedToolWithHooks(
    prepared: PreparedRuntimeTool,
    context: RuntimeToolExecutionContext,
    hooks: { beforePermissionHook?: HookResult | undefined; afterPermissionHook?: HookResult | undefined } = {},
  ): Promise<ToolExecutionResult> {
    const beforeExecuteHook = await this.runToolHook("tool.before_execute", {
      toolName: prepared.toolName,
      tool: toolToDefinition(prepared.tool),
      call: prepared.call,
      context,
    });
    if (beforeExecuteHook.blockExecution || beforeExecuteHook.permissionDecision === "deny") {
      return this.hookBlockedResult(prepared.toolName, beforeExecuteHook, "before_execute");
    }
    try {
      let result = await this.executePreparedTool(prepared, context);
      throwIfAborted(context.signal, "Tool execution aborted");
      result = this.mergeHookData(result, hooks.beforePermissionHook, "before_permission");
      result = this.mergeHookData(result, hooks.afterPermissionHook, "after_permission");
      result = this.mergeHookData(result, beforeExecuteHook, "before_execute");
      const afterExecuteHook = await this.runToolHook("tool.after_execute", {
        toolName: prepared.toolName,
        tool: toolToDefinition(prepared.tool),
        call: prepared.call,
        context,
        result,
      });
      result = this.mergeHookData(result, afterExecuteHook, "after_execute");
      return result;
    } catch (error) {
      if (isAbortError(error) || context.signal?.aborted) {
        throw error;
      }
      const onErrorHook = await this.runToolHook("tool.on_error", {
        toolName: prepared.toolName,
        tool: toolToDefinition(prepared.tool),
        call: prepared.call,
        context,
        error,
      });
      if (onErrorHook.blockExecution) {
        return this.hookBlockedResult(prepared.toolName, onErrorHook, "on_error");
      }
      const result = errorResult(`工具执行异常: ${error instanceof Error ? error.message : String(error)}`, prepared.toolName);
      return this.mergeHookData(result, onErrorHook, "on_error");
    }
  }

  private async executeToolAfterApproval(
    prepared: PreparedRuntimeTool,
    approvalDecision: RuntimeToolApprovalDecision,
    withHooks: boolean,
    hooks: { beforePermissionHook?: HookResult | undefined; afterPermissionHook?: HookResult | undefined } = {},
  ): Promise<ToolExecutionResult> {
    const toolName = approvalDecision.toolName;
    const approvalMetadata = buildApprovalMetadata(approvalDecision);
    if (!this.pendingInteractions) {
      return errorResult(`工具 ${toolName} 需要用户授权，但当前上下文不支持审批`, toolName, {
        ...mergeToolPermissionMetadata({}, prepared.toolPermission),
        approval: approvalMetadata,
      });
    }

    const sessionId = prepared.context.sessionId?.trim();
    if (!sessionId) {
      return errorResult(`工具 ${toolName} 需要用户授权，但当前上下文无法等待审批`, toolName, {
        ...mergeToolPermissionMetadata({}, prepared.toolPermission),
        approval: approvalMetadata,
      });
    }

    let resolution;
    try {
      resolution = await this.pendingInteractions.waitForApproval({
        sessionId,
        runId: prepared.context.runId,
        taskId: prepared.context.taskId,
        requestId: prepared.context.requestId,
        toolCallId: prepared.context.toolCallId ?? prepared.call.callId ?? null,
        agentName: prepared.context.currentAgentName ?? prepared.context.agent?.agent_name ?? null,
        approvalType: prepared.toolPermission?.approvalType ?? "tool_execution",
        toolName,
        arguments: this.approvalArguments(prepared),
        riskLevel: approvalDecision.riskLevel,
        description: approvalDecision.description,
        permissionMode: approvalDecision.permissionMode,
        approvalReason: approvalDecision.reason,
        approvalReasonCodes: approvalDecision.reasonCodes,
        approvalSecondaryReasons: approvalDecision.secondaryReasons,
        approvedExternalPaths: approvalDecision.approvedExternalPaths,
        signal: prepared.context.signal,
      });
    } catch (error) {
      return errorResult(`审批流程异常: ${error instanceof Error ? error.message : String(error)}`, toolName, {
        ...mergeToolPermissionMetadata({}, prepared.toolPermission),
        approval: approvalMetadata,
      });
    }

    if (!resolution.approved) {
      const denyReason = resolution.message || "用户拒绝执行此操作";
      return errorResult(`工具 ${toolName} 执行已被拒绝：${denyReason}`, toolName, {
        approval: buildApprovalMetadata(approvalDecision, resolution.message),
      });
    }

    const contextWithPaths = withApprovedExternalPaths(prepared.context, approvalDecision.approvedExternalPaths);
    const result = withHooks
      ? await this.executePreparedToolWithHooks(prepared, contextWithPaths, hooks)
      : await this.executePreparedTool(prepared, contextWithPaths);
    return withApprovalMetadata(result, approvalDecision, resolution.message);
  }

  private approvalArguments(prepared: PreparedRuntimeTool): Record<string, unknown> {
    return prepared.toolPermission?.arguments ?? prepared.call.arguments ?? {};
  }

  private async runToolHook(
    eventName: "tool.before_permission" | "tool.after_permission" | "tool.before_execute" | "tool.after_execute" | "tool.on_error",
    input: Parameters<HookRuntimeService["runToolHook"]>[1],
  ): Promise<HookResult> {
    return this.hooks ? this.hooks.runToolHook(eventName, input) : {
      continueExecution: true,
      blockExecution: false,
      blockReason: "",
    };
  }

  private mergeHookData<T>(
    result: ToolExecutionResult<T>,
    hookResult: HookResult | undefined,
    phase: "before_permission" | "after_permission" | "before_execute" | "after_execute" | "on_error",
  ): ToolExecutionResult<T> {
    return hookResult && this.hooks ? this.hooks.mergeHookData(result, hookResult, phase) : result;
  }

  private hookBlockedResult(
    toolName: string,
    hookResult: HookResult,
    phase: "before_permission" | "after_permission" | "before_execute" | "after_execute" | "on_error",
  ): ToolExecutionResult<string> {
    const result = errorResult(hookResult.blockReason || "Hook blocked tool execution", toolName, {
      hook_blocked: true,
      hook_phase: phase,
      ...(hookResult.permissionDecision ? { hook_permission_decision: hookResult.permissionDecision } : {}),
    });
    return this.mergeHookData(result, hookResult, phase);
  }
}

function attachPermissionRuntimeData(
  input: Record<string, unknown>,
  permission: RuntimeToolPermissionResult | null,
): void {
  const bashPlan = permission?.metadata?.bash_plan;
  if (!bashPlan) {
    return;
  }
  Object.defineProperty(input, "__runtime_bash_plan", {
    value: bashPlan,
    enumerable: false,
    configurable: true,
  });
}

function isToolResult(value: unknown): value is ToolExecutionResult {
  return isRecord(value) && typeof value.success === "boolean" && typeof value.tool_name === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
