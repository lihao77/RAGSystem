import type { BashExecutionPlan, LocalBashToolService } from "../../tools/local-bash-tool-service.js";
import type { HookResult, RuntimeHookToolInput } from "../hooks/index.js";
import type { PendingInteractionService } from "../pending-interaction-service.js";
import type { RuntimeToolApprovalDecision, PermissionPolicyService } from "../permission-policy-service.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolProvider,
  RuntimeToolProviderVisibilityInput,
  ToolExecutionResult,
} from "../runtime-tool-types.js";
import {
  approvalUnsupportedError,
  buildApprovalMetadata,
  errorResult,
  readBashArguments,
  withApprovalMetadata,
  withApprovedExternalPaths,
} from "../runtime-tool-bridge/arguments.js";
import { EXECUTE_BASH_TOOL, EXECUTE_BASH_TOOL_NAME } from "../runtime-tool-bridge/registry.js";

export interface BashToolProviderHooks {
  runToolHook(
    eventName: "tool.after_permission" | "tool.before_execute" | "tool.after_execute",
    input: RuntimeHookToolInput,
  ): Promise<HookResult>;
  mergeHookData<T>(
    result: ToolExecutionResult<T>,
    hookResult: HookResult | undefined,
    phase: "before_permission" | "after_permission" | "before_execute" | "after_execute",
  ): ToolExecutionResult<T>;
  hookBlockedResult(
    toolName: string,
    hookResult: HookResult,
    phase: "after_permission" | "before_execute",
  ): ToolExecutionResult<string>;
  applyHookPermissionDecision(
    decision: RuntimeToolApprovalDecision | undefined,
    hookResult: HookResult,
    toolName: string,
    riskLevel: RuntimeToolApprovalDecision["riskLevel"] | undefined,
  ): RuntimeToolApprovalDecision | undefined;
}

export class BashToolProvider implements RuntimeToolProvider {
  readonly id = "bash";
  readonly handlesOwnExecution = true;

  constructor(
    private readonly bashTools: LocalBashToolService | null,
    private readonly pendingInteractions: PendingInteractionService | null,
    private readonly permissionPolicy: PermissionPolicyService | null,
    private readonly hooks: BashToolProviderHooks,
  ) {}

  listTools(input: RuntimeToolProviderVisibilityInput): RuntimeToolDefinition[] {
    const enabledTools = new Set(input.agent?.tools.enabled_tools ?? []);
    return this.bashTools && enabledTools.has(EXECUTE_BASH_TOOL_NAME) ? [{ ...EXECUTE_BASH_TOOL }] : [];
  }

  canHandle(toolName: string): boolean {
    return toolName === EXECUTE_BASH_TOOL_NAME;
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext): Promise<ToolExecutionResult> {
    return this.executeBashTool(call, context);
  }

  async executeToolWithHooks(
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
    beforePermissionHook: HookResult,
  ): Promise<ToolExecutionResult> {
    if (!this.bashTools) {
      return errorResult(`工具未暴露或暂未迁移: ${EXECUTE_BASH_TOOL_NAME}`, EXECUTE_BASH_TOOL_NAME);
    }
    const bashInput = readBashArguments(call.arguments);
    const approvedExternalPaths = this.bashTools.getExternalPathApprovalCandidates(bashInput, context);
    if (!this.permissionPolicy && approvedExternalPaths.length) {
      return approvalUnsupportedError(EXECUTE_BASH_TOOL_NAME, approvedExternalPaths);
    }
    const planningContext = withApprovedExternalPaths(context, approvedExternalPaths);
    const prepared = this.bashTools.prepareExecution(bashInput, planningContext);
    if (!prepared.ok) {
      return prepared.result;
    }

    const plan = prepared.plan;
    const approvalDecision = this.hooks.applyHookPermissionDecision(this.permissionPolicy?.evaluateToolApproval({
      toolName: EXECUTE_BASH_TOOL_NAME,
      riskLevel: plan.riskLevel,
      description: plan.approvalDescription,
      arguments: plan.approvalArguments,
      sessionId: context.sessionId,
      forceAsk: plan.approvalRequired,
      approvedExternalPaths,
    }), beforePermissionHook, EXECUTE_BASH_TOOL_NAME, plan.riskLevel);
    const afterPermissionHook = await this.hooks.runToolHook("tool.after_permission", {
      toolName: EXECUTE_BASH_TOOL_NAME,
      tool: {
        riskLevel: plan.riskLevel,
        source: "execution",
      },
      call,
      context,
      permissionDecision: approvalDecision ?? null,
    });
    if (afterPermissionHook.blockExecution || afterPermissionHook.permissionDecision === "deny") {
      return this.hooks.hookBlockedResult(EXECUTE_BASH_TOOL_NAME, afterPermissionHook, "after_permission");
    }
    const finalApprovalDecision = this.hooks.applyHookPermissionDecision(
      approvalDecision,
      afterPermissionHook,
      EXECUTE_BASH_TOOL_NAME,
      plan.riskLevel,
    );

    if (finalApprovalDecision?.action === "ask") {
      return this.executeBashAfterApproval(plan, call, context, finalApprovalDecision, true);
    }
    if (!finalApprovalDecision && plan.approvalRequired) {
      return errorResult(`工具 ${EXECUTE_BASH_TOOL_NAME} 需要用户授权，但当前上下文不支持审批`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
      });
    }

    return this.executeBashPlanWithHooks(
      plan,
      call,
      withApprovedExternalPaths(context, finalApprovalDecision?.approvedExternalPaths),
      { beforePermissionHook, afterPermissionHook },
    );
  }

  private async executeBashTool(
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!this.bashTools) {
      return errorResult(`工具未暴露或暂未迁移: ${EXECUTE_BASH_TOOL_NAME}`, EXECUTE_BASH_TOOL_NAME);
    }
    const bashInput = readBashArguments(call.arguments);
    const approvedExternalPaths = this.bashTools.getExternalPathApprovalCandidates(bashInput, context);
    if (!this.permissionPolicy && approvedExternalPaths.length) {
      return approvalUnsupportedError(EXECUTE_BASH_TOOL_NAME, approvedExternalPaths);
    }
    const planningContext = withApprovedExternalPaths(context, approvedExternalPaths);
    const prepared = this.bashTools.prepareExecution(bashInput, planningContext);
    if (!prepared.ok) {
      return prepared.result;
    }

    const plan = prepared.plan;
    const approvalDecision = this.permissionPolicy?.evaluateToolApproval({
      toolName: EXECUTE_BASH_TOOL_NAME,
      riskLevel: plan.riskLevel,
      description: plan.approvalDescription,
      arguments: plan.approvalArguments,
      sessionId: context.sessionId,
      forceAsk: plan.approvalRequired,
      approvedExternalPaths,
    });

    if (approvalDecision?.action === "ask") {
      return this.executeBashAfterApproval(plan, call, context, approvalDecision, false);
    }
    if (!approvalDecision && plan.approvalRequired) {
      return errorResult(`工具 ${EXECUTE_BASH_TOOL_NAME} 需要用户授权，但当前上下文不支持审批`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
      });
    }

    return this.bashTools.executePlan(plan, withApprovedExternalPaths(context, approvalDecision?.approvedExternalPaths));
  }

  private async executeBashPlanWithHooks(
    plan: BashExecutionPlan,
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
    hooks: { beforePermissionHook?: HookResult | undefined; afterPermissionHook?: HookResult | undefined } = {},
  ): Promise<ToolExecutionResult> {
    const bashTools = this.bashTools;
    if (!bashTools) {
      return errorResult(`工具未暴露或暂未迁移: ${EXECUTE_BASH_TOOL_NAME}`, EXECUTE_BASH_TOOL_NAME);
    }
    const tool = {
      riskLevel: plan.riskLevel,
      source: "execution" as const,
    };
    const beforeExecuteHook = await this.hooks.runToolHook("tool.before_execute", {
      toolName: EXECUTE_BASH_TOOL_NAME,
      tool,
      call,
      context,
    });
    if (beforeExecuteHook.blockExecution || beforeExecuteHook.permissionDecision === "deny") {
      return this.hooks.hookBlockedResult(EXECUTE_BASH_TOOL_NAME, beforeExecuteHook, "before_execute");
    }
    let result = await bashTools.executePlan(plan, context);
    result = this.hooks.mergeHookData(result, hooks.beforePermissionHook, "before_permission");
    result = this.hooks.mergeHookData(result, hooks.afterPermissionHook, "after_permission");
    result = this.hooks.mergeHookData(result, beforeExecuteHook, "before_execute");
    const afterExecuteHook = await this.hooks.runToolHook("tool.after_execute", {
      toolName: EXECUTE_BASH_TOOL_NAME,
      tool,
      call,
      context,
      result,
    });
    return this.hooks.mergeHookData(result, afterExecuteHook, "after_execute");
  }

  private async executeBashAfterApproval(
    plan: BashExecutionPlan,
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
    approvalDecision: RuntimeToolApprovalDecision,
    withHooks: boolean,
  ): Promise<ToolExecutionResult> {
    const approvalMetadata = buildApprovalMetadata(approvalDecision);
    if (!this.pendingInteractions) {
      return errorResult(`工具 ${EXECUTE_BASH_TOOL_NAME} 需要用户授权，但当前上下文不支持审批`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
        approval: approvalMetadata,
      });
    }

    const sessionId = context.sessionId?.trim();
    if (!sessionId) {
      return errorResult(`工具 ${EXECUTE_BASH_TOOL_NAME} 需要用户授权，但当前上下文无法等待审批`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
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
        approvalType: "bash_command",
        toolName: EXECUTE_BASH_TOOL_NAME,
        arguments: plan.approvalArguments,
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
      return errorResult(`审批流程异常: ${error instanceof Error ? error.message : String(error)}`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
        approval: approvalMetadata,
      });
    }

    if (!resolution.approved) {
      const denyReason = resolution.message || "用户拒绝执行此操作";
      return errorResult(`execute_bash 执行已被拒绝：${denyReason}`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
        approval: buildApprovalMetadata(approvalDecision, resolution.message),
      });
    }

    const contextWithPaths = withApprovedExternalPaths(context, approvalDecision.approvedExternalPaths);
    const result = withHooks
      ? await this.executeBashPlanWithHooks(plan, call, contextWithPaths)
      : await this.bashTools!.executePlan(plan, contextWithPaths);
    return withApprovalMetadata(result, approvalDecision, resolution.message);
  }
}
