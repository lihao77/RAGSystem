/**
 * ApprovalInteraction 端口适配器 —— 把 backend-ts PendingInteractionService 适配成 SDK 的 ApprovalInteraction 端口。
 *
 * SDK 内置审批编排在 action=ask 时调用本端口阻塞等待用户审批。本适配器把 SDK 的 ApprovalRequest
 * 映射成 backend-ts waitForApproval 入参（发布 interaction:approval 事件到 outbox，阻塞至 respondApproval），
 * 再把 PendingApprovalResolution 映射回 SDK ApprovalResolution。
 *
 * 本适配器只透传 SDK ToolExecContext 已携带的标量（sessionId/runId/taskId/requestId/toolCallId）。
 */
import type { ApprovalInteraction, ApprovalRequest, ApprovalResolution, ToolExecContext } from "@ragsystem/agent-sdk";
import type { PendingApprovalRequest, PendingApprovalResolution, PendingInteractionService } from "../../runtime/pending-interaction-service.js";

export interface SdkApprovalInteractionAdapterOptions {
  /** backend-ts 审批交互服务（发布审批事件 + 阻塞等待用户响应）。 */
  service: PendingInteractionService;
  /** 当次 run 的 agent 名（写入审批事件供前端展示）。 */
  agentName: string;
}

export class SdkApprovalInteractionAdapter implements ApprovalInteraction {
  constructor(private readonly options: SdkApprovalInteractionAdapterOptions) {}

  async waitForApproval(request: ApprovalRequest): Promise<ApprovalResolution> {
    const pendingRequest: PendingApprovalRequest = {
      sessionId: requireSessionId(request.ctx),
      agentName: this.options.agentName,
      approvalType: "tool_execution",
      toolName: request.toolName,
      arguments: request.arguments,
      riskLevel: request.riskLevel,
      description: request.description,
      approvalReason: request.reason,
      ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
      ...(request.reasonCodes?.length ? { approvalReasonCodes: request.reasonCodes } : {}),
      ...(request.secondaryReasons?.length ? { approvalSecondaryReasons: request.secondaryReasons } : {}),
      ...(request.approvedExternalPaths?.length ? { approvedExternalPaths: request.approvedExternalPaths } : {}),
      runId: request.ctx.runId ?? undefined,
      taskId: request.ctx.taskId ?? undefined,
      requestId: request.ctx.requestId ?? undefined,
      toolCallId: request.ctx.toolCallId ?? undefined,
      ...(request.ctx.signal ? { signal: request.ctx.signal } : {}),
    };
    let resolution: PendingApprovalResolution;
    try {
      resolution = await this.options.service.waitForApproval(pendingRequest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { approved: false, reason: message || "审批流程异常" };
    }
    if (resolution.approved) {
      return { approved: true, message: resolution.message };
    }
    return { approved: false, reason: resolution.message || "用户拒绝执行此操作" };
  }
}

function requireSessionId(ctx: ToolExecContext): string {
  if (!ctx.sessionId) {
    throw new Error("审批交互需要 session_id");
  }
  return ctx.sessionId;
}
