import type { ToolExecutionResult } from "../runtime-tool-types.js";
import type { PendingInteractionService } from "../pending-interaction-service.js";
import type {
  PermissionPolicyService,
  RuntimeToolApprovalDecision,
} from "../permission-policy-service.js";
import type { PreparedRuntimeTool } from "./prepared.js";
import {
  approvalUnsupportedError,
  buildApprovalMetadata,
  errorResult,
} from "./arguments.js";
import {
  isToolPermissionForceAsk,
  mergeToolPermissionMetadata,
} from "../../../tools/permissions.js";

/** waitForApproval 结果:要么已可返回的(拒绝/不支持/异常)结果,要么已批准并携带用户留言。 */
export type ApprovalResolution =
  | { approved: false; result: ToolExecutionResult }
  | { approved: true; message: string };

/**
 * 审批协调——为 CodeExecution 工具互调提供审批判定 + 阻塞等待。
 * SDK 主路径的审批编排已在 tool-round-executor；本类仅供 bridge.executeTool(互调入口)使用。
 */
export class ToolApprovalCoordinator {
  constructor(
    private readonly permissionPolicy: PermissionPolicyService | null,
    private readonly pendingInteractions: PendingInteractionService | null,
  ) {}

  arguments(prepared: PreparedRuntimeTool): Record<string, unknown> {
    return prepared.toolPermission?.arguments ?? prepared.call.arguments ?? {};
  }

  evaluate(
    prepared: PreparedRuntimeTool,
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

    return this.permissionPolicy.evaluateToolApproval({
      toolName: prepared.toolName,
      riskLevel: prepared.toolPermission?.riskLevel ?? prepared.tool.riskLevel,
      description: prepared.toolPermission?.description ?? prepared.tool.description,
      arguments: this.arguments(prepared),
      sessionId: prepared.context.sessionId,
      approvalExempt: prepared.tool.approvalExempt,
      forceAsk: isToolPermissionForceAsk(prepared.toolPermission),
      approvedExternalPaths: prepared.approvedExternalPaths,
    });
  }

  async waitForApproval(
    prepared: PreparedRuntimeTool,
    approvalDecision: RuntimeToolApprovalDecision,
  ): Promise<ApprovalResolution> {
    const toolName = approvalDecision.toolName;
    const approvalMetadata = buildApprovalMetadata(approvalDecision);
    if (!this.pendingInteractions) {
      return {
        approved: false,
        result: errorResult(`工具 ${toolName} 需要用户授权，但当前上下文不支持审批`, toolName, {
          ...mergeToolPermissionMetadata({}, prepared.toolPermission),
          approval: approvalMetadata,
        }),
      };
    }

    const sessionId = prepared.context.sessionId?.trim();
    if (!sessionId) {
      return {
        approved: false,
        result: errorResult(`工具 ${toolName} 需要用户授权，但当前上下文无法等待审批`, toolName, {
          ...mergeToolPermissionMetadata({}, prepared.toolPermission),
          approval: approvalMetadata,
        }),
      };
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
        arguments: this.arguments(prepared),
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
      return {
        approved: false,
        result: errorResult(`审批流程异常: ${error instanceof Error ? error.message : String(error)}`, toolName, {
          ...mergeToolPermissionMetadata({}, prepared.toolPermission),
          approval: approvalMetadata,
        }),
      };
    }

    if (!resolution.approved) {
      const denyReason = resolution.message || "用户拒绝执行此操作";
      return {
        approved: false,
        result: errorResult(`工具 ${toolName} 执行已被拒绝：${denyReason}`, toolName, {
          approval: buildApprovalMetadata(approvalDecision, resolution.message),
        }),
      };
    }

    return { approved: true, message: resolution.message };
  }
}
