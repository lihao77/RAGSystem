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
  RuntimeToolProvider,
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
import { BashToolProvider } from "./runtime-tool-providers/bash-tool-provider.js";
import { CodeExecutionToolProvider } from "./runtime-tool-providers/code-execution-tool-provider.js";
import { DelegationToolProvider } from "./runtime-tool-providers/delegation-tool-provider.js";
import { DocumentToolProvider } from "./runtime-tool-providers/document-tool-provider.js";
import { KnowledgeToolProvider } from "./runtime-tool-providers/knowledge-tool-provider.js";
import { LocalSearchToolProvider } from "./runtime-tool-providers/local-search-tool-provider.js";
import { McpToolProvider } from "./runtime-tool-providers/mcp-tool-provider.js";
import { MemoryToolProvider } from "./runtime-tool-providers/memory-tool-provider.js";
import { RequestUserInputToolProvider } from "./runtime-tool-providers/request-user-input-tool-provider.js";
import { SkillToolProvider } from "./runtime-tool-providers/skill-tool-provider.js";
import { TaskToolProvider } from "./runtime-tool-providers/task-tool-provider.js";
import {
  approvalUnsupportedError,
  buildApprovalMetadata,
  buildToolCallContext,
  dedupeStrings,
  errorResult,
  withApprovalMetadata,
  withApprovedExternalPaths,
} from "./runtime-tool-bridge/arguments.js";
export { isReadOnlyMemoryToolName } from "./runtime-tool-bridge/arguments.js";

export class RuntimeToolBridge implements RuntimeToolExecutor {
  private agentDelegation: AgentDelegationService | null = null;
  private readonly toolProviders: RuntimeToolProvider[];

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
    this.toolProviders = [
      new RequestUserInputToolProvider(pendingInteractions),
      new DocumentToolProvider(documentTools),
      new BashToolProvider(bashTools, pendingInteractions, permissionPolicy, {
        runToolHook: (eventName, hookInput) => this.runToolHook(eventName, hookInput),
        mergeHookData: (result, hookResult, phase) => this.mergeHookData(result, hookResult, phase),
        hookBlockedResult: (toolName, hookResult, phase) => this.hookBlockedResult(toolName, hookResult, phase),
        applyHookPermissionDecision: (decision, hookResult, toolName, riskLevel) =>
          this.applyHookPermissionDecision(decision, hookResult, toolName, riskLevel),
      }),
      new MemoryToolProvider(memoryTools),
      new LocalSearchToolProvider(searchTools),
      new CodeExecutionToolProvider(codeExecutionTools),
      new SkillToolProvider(skillTools),
      new KnowledgeToolProvider(vectorLibrary),
      new TaskToolProvider(taskTools),
      new DelegationToolProvider(() => this.agentDelegation),
      new McpToolProvider(mcp),
    ];
  }

  setAgentDelegation(agentDelegation: AgentDelegationService | null): void {
    this.agentDelegation = agentDelegation;
  }

  listVisibleTools(agent: AgentConfig | null): RuntimeToolDefinition[] {
    return this.toolProviders.flatMap((provider) => provider.listTools({ agent }));
  }

  listVisibleToolNames(agent: AgentConfig | null): string[] {
    return this.listVisibleTools(agent).map((tool) => tool.name);
  }

  canExecuteTool(toolName: string, agent: AgentConfig | null): boolean {
    return this.listVisibleToolNames(agent).includes(toolName);
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext): ToolExecutionResult | Promise<ToolExecutionResult> {
    throwIfAborted(context.signal, "Tool execution aborted");
    if (this.hooks) {
      return this.executeToolWithHooks(call, context);
    }
    const executionContext = buildToolCallContext(call, context);
    const toolName = call.toolName.trim();
    const tool = this.getVisibleTool(toolName, executionContext.agent);
    if (!tool) {
      return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName || "unknown");
    }

    const provider = this.toolProviders.find((item) => item.canHandle(toolName));
    if (provider?.handlesOwnExecution) {
      return provider.executeTool(call, executionContext);
    }

    const approvedExternalPaths = this.collectExternalPathApprovalCandidates(toolName, call.arguments, executionContext);
    const approvalDecision = this.permissionPolicy?.evaluateToolApproval({
      toolName,
      riskLevel: tool.riskLevel,
      description: tool.description,
      arguments: call.arguments ?? {},
      sessionId: executionContext.sessionId,
      approvalExempt: tool.approvalExempt,
      approvedExternalPaths,
    });
    if (approvalDecision?.action === "ask") {
      return this.executeToolAfterApproval(call, executionContext, approvalDecision);
    }
    if (!approvalDecision && approvedExternalPaths.length) {
      return approvalUnsupportedError(toolName, approvedExternalPaths);
    }

    return this.executeAllowedTool(
      toolName,
      call,
      withApprovedExternalPaths(executionContext, approvalDecision?.approvedExternalPaths),
    );
  }

  private async executeToolWithHooks(call: RuntimeToolCall, context: RuntimeToolExecutionContext): Promise<ToolExecutionResult> {
    throwIfAborted(context.signal, "Tool execution aborted");
    const executionContext = buildToolCallContext(call, context);
    const toolName = call.toolName.trim();
    const tool = this.getVisibleTool(toolName, executionContext.agent);
    if (!tool) {
      return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName || "unknown");
    }

    const beforePermissionHook = await this.runToolHook("tool.before_permission", {
      toolName,
      tool,
      call,
      context: executionContext,
    });
    if (beforePermissionHook.blockExecution || beforePermissionHook.permissionDecision === "deny") {
      return this.hookBlockedResult(toolName, beforePermissionHook, "before_permission");
    }

    const provider = this.toolProviders.find((item) => item.canHandle(toolName));
    if (provider?.handlesOwnExecution) {
      const maybeBashProvider = provider as RuntimeToolProvider & {
        executeToolWithHooks?: (
          call: RuntimeToolCall,
          context: RuntimeToolExecutionContext,
          beforePermissionHook: HookResult,
        ) => Promise<ToolExecutionResult> | ToolExecutionResult;
      };
      return maybeBashProvider.executeToolWithHooks
        ? maybeBashProvider.executeToolWithHooks(call, executionContext, beforePermissionHook)
        : provider.executeTool(call, executionContext);
    }

    const approvedExternalPaths = this.collectExternalPathApprovalCandidates(toolName, call.arguments, executionContext);
    const approvalDecision = this.applyHookPermissionDecision(this.permissionPolicy?.evaluateToolApproval({
      toolName,
      riskLevel: tool.riskLevel,
      description: tool.description,
      arguments: call.arguments ?? {},
      sessionId: executionContext.sessionId,
      approvalExempt: tool.approvalExempt,
      approvedExternalPaths,
    }), beforePermissionHook, toolName, tool.riskLevel);
    const afterPermissionHook = await this.runToolHook("tool.after_permission", {
      toolName,
      tool,
      call,
      context: executionContext,
      permissionDecision: approvalDecision ?? null,
    });
    if (afterPermissionHook.blockExecution || afterPermissionHook.permissionDecision === "deny") {
      return this.hookBlockedResult(toolName, afterPermissionHook, "after_permission");
    }
    const finalApprovalDecision = this.applyHookPermissionDecision(
      approvalDecision,
      afterPermissionHook,
      toolName,
      tool.riskLevel,
    );
    if (finalApprovalDecision?.action === "ask") {
      return this.executeToolAfterApproval(call, executionContext, finalApprovalDecision);
    }
    if (!approvalDecision && approvedExternalPaths.length) {
      return approvalUnsupportedError(toolName, approvedExternalPaths);
    }

    return this.executeAllowedToolWithHooks(
      toolName,
      call,
      withApprovedExternalPaths(executionContext, finalApprovalDecision?.approvedExternalPaths),
      { beforePermissionHook, afterPermissionHook },
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

  private getVisibleTool(toolName: string, agent: AgentConfig | null): RuntimeToolDefinition | null {
    return this.listVisibleTools(agent).find((tool) => tool.name === toolName) ?? null;
  }

  private executeAllowedTool(
    toolName: string,
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
  ): ToolExecutionResult | Promise<ToolExecutionResult> {
    throwIfAborted(context.signal, "Tool execution aborted");
    const provider = this.toolProviders.find((item) => item.canHandle(toolName));
    if (provider) {
      return provider.executeTool(call, context);
    }
    return this.unavailableTool(toolName);
  }

  private async executeAllowedToolWithHooks(
    toolName: string,
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
    hooks: { beforePermissionHook?: HookResult | undefined; afterPermissionHook?: HookResult | undefined } = {},
  ): Promise<ToolExecutionResult> {
    const tool = this.getVisibleTool(toolName, context.agent);
    const beforeExecuteHook = await this.runToolHook("tool.before_execute", {
      toolName,
      tool,
      call,
      context,
    });
    if (beforeExecuteHook.blockExecution || beforeExecuteHook.permissionDecision === "deny") {
      return this.hookBlockedResult(toolName, beforeExecuteHook, "before_execute");
    }
    try {
      let result = await this.executeAllowedTool(toolName, call, context);
      throwIfAborted(context.signal, "Tool execution aborted");
      result = this.mergeHookData(result, hooks.beforePermissionHook, "before_permission");
      result = this.mergeHookData(result, hooks.afterPermissionHook, "after_permission");
      result = this.mergeHookData(result, beforeExecuteHook, "before_execute");
      const afterExecuteHook = await this.runToolHook("tool.after_execute", {
        toolName,
        tool,
        call,
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
        toolName,
        tool,
        call,
        context,
        error,
      });
      if (onErrorHook.blockExecution) {
        return this.hookBlockedResult(toolName, onErrorHook, "on_error");
      }
      const result = errorResult(`工具执行异常: ${error instanceof Error ? error.message : String(error)}`, toolName);
      return this.mergeHookData(result, onErrorHook, "on_error");
    }
  }

  private unavailableTool(toolName: string): ToolExecutionResult<string> {
    return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName);
  }

  private collectExternalPathApprovalCandidates(
    toolName: string,
    args: Record<string, unknown> | undefined,
    context: RuntimeToolExecutionContext,
  ): string[] {
    return dedupeStrings(this.toolProviders.flatMap((provider) =>
      provider.getExternalPathApprovalCandidates?.(toolName, args, context) ?? [],
    ));
  }

  private async executeToolAfterApproval(
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
    approvalDecision: RuntimeToolApprovalDecision,
  ): Promise<ToolExecutionResult> {
    const toolName = approvalDecision.toolName;
    const approvalMetadata = buildApprovalMetadata(approvalDecision);
    if (!this.pendingInteractions) {
      return errorResult(`工具 ${toolName} 需要用户授权，但当前上下文不支持审批`, toolName, {
        approval: approvalMetadata,
      });
    }

    const sessionId = context.sessionId?.trim();
    if (!sessionId) {
      return errorResult(`工具 ${toolName} 需要用户授权，但当前上下文无法等待审批`, toolName, {
        approval: approvalMetadata,
      });
    }

    let resolution;
    try {
      resolution = await this.pendingInteractions.waitForApproval({
        sessionId,
        runId: context.runId,
        taskId: context.taskId,
        requestId: context.requestId,
        toolCallId: context.toolCallId ?? call.callId ?? null,
        agentName: context.currentAgentName ?? context.agent?.agent_name ?? null,
        approvalType: "tool_execution",
        toolName,
        arguments: call.arguments ?? {},
        riskLevel: approvalDecision.riskLevel,
        description: approvalDecision.description,
        permissionMode: approvalDecision.permissionMode,
        approvalReason: approvalDecision.reason,
        approvalReasonCodes: approvalDecision.reasonCodes,
        approvalSecondaryReasons: approvalDecision.secondaryReasons,
        approvedExternalPaths: approvalDecision.approvedExternalPaths,
        signal: context.signal,
      });
    } catch (error) {
      return errorResult(`审批流程异常: ${error instanceof Error ? error.message : String(error)}`, toolName, {
        approval: approvalMetadata,
      });
    }

    if (!resolution.approved) {
      const denyReason = resolution.message || "用户拒绝执行此操作";
      return errorResult(`工具 ${toolName} 执行已被拒绝：${denyReason}`, toolName, {
        approval: buildApprovalMetadata(approvalDecision, resolution.message),
      });
    }

    const result = await this.executeAllowedToolWithHooks(toolName, call, withApprovedExternalPaths(context, approvalDecision.approvedExternalPaths));
    return withApprovalMetadata(result, approvalDecision, resolution.message);
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

  private applyHookPermissionDecision(
    decision: RuntimeToolApprovalDecision | undefined,
    hookResult: HookResult,
    toolName: string,
    riskLevel: RuntimeToolApprovalDecision["riskLevel"] | undefined,
  ): RuntimeToolApprovalDecision | undefined {
    if (!hookResult.permissionDecision) {
      return decision;
    }
    if (hookResult.permissionDecision === "allow") {
      return {
        ...(decision ?? buildHookApprovalDecision(toolName, riskLevel)),
        action: "allow",
        reason: "hook permission decision: allow",
      };
    }
    if (hookResult.permissionDecision === "ask") {
      return {
        ...(decision ?? buildHookApprovalDecision(toolName, riskLevel)),
        action: "ask",
        reason: hookResult.uiMessage ?? "hook permission decision: ask",
        reasonCodes: [...(decision?.reasonCodes ?? []), "ask-hook"],
      };
    }
    return decision;
  }
}

function buildHookApprovalDecision(
  toolName: string,
  riskLevel: RuntimeToolApprovalDecision["riskLevel"] | undefined,
): RuntimeToolApprovalDecision {
  return {
    action: "allow",
    toolName,
    riskLevel: riskLevel ?? "low",
    description: `Tool ${toolName}`,
    permissionMode: "standard",
    reason: "hook permission decision",
    reasonCodes: [],
    secondaryReasons: [],
    approvedExternalPaths: [],
  };
}
