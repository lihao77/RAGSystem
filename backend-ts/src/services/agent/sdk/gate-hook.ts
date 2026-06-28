/**
 * tool.gate hook（backend）：审批策略判 + ask 时阻塞审批交互。
 *
 * 迁自 SDK registerPermissionGateHandler + SdkPermissionPolicyAdapter/SdkApprovalInteractionAdapter
 * （审批编排从 SDK 内核迁出归 backend；SDK 不再认识审批业务）。
 *
 * 阶段 1：ToolGateInput 仍带 forceAsk/riskLevel/approvedExternalPaths（SDK preparer 据 tool.checkAccess
 * 派生），handler 据此调 backend 审批服务。阶段 2 删 approvedExternalPaths 链时再调整。
 */
import type { HookRegistry, ToolExecContext } from "@ragsystem/agent-sdk";
import { isAbortError, throwIfAborted } from "@ragsystem/agent-protocol";
import type { RiskLevel } from "../../../contracts/permissions.js";
import type { PermissionPolicyService, RuntimeToolApprovalInput } from "../../runtime/permission-policy-service.js";
import type { PendingInteractionService, PendingApprovalRequest } from "../../runtime/pending-interaction-service.js";

export interface GateHookDeps {
  permissionPolicy: PermissionPolicyService;
  pendingInteractions: PendingInteractionService;
  agentName: string;
}

export function registerGateHook(hooks: HookRegistry, deps: GateHookDeps): void {
  hooks.on("tool.gate", async (input) => {
    const serviceInput: RuntimeToolApprovalInput = {
      toolName: input.toolName,
      riskLevel: normalizeRiskLevel(input.riskLevel),
      arguments: input.arguments,
      sessionId: input.ctx.sessionId ?? undefined,
      approvalExempt: input.approvalExempt,
      ...(input.forceAsk ? { forceAsk: true } : {}),
      ...(input.approvedExternalPaths.length ? { approvedExternalPaths: input.approvedExternalPaths } : {}),
    };
    let decision;
    try {
      decision = deps.permissionPolicy.evaluateToolApproval(serviceInput);
    } catch (error) {
      if (isAbortError(error) || input.ctx.signal?.aborted) { throw error; }
      return { decision: "deny" as const, reason: `审批策略异常: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (decision.action === "allow") {
      return { decision: "allow" as const, ...(decision.approvedExternalPaths.length ? { approvedPaths: decision.approvedExternalPaths } : {}) };
    }
    // ask：阻塞等用户审批
    throwIfAborted(input.ctx.signal, "Agent run aborted");
    const pendingRequest: PendingApprovalRequest = {
      sessionId: requireSessionId(input.ctx),
      agentName: deps.agentName,
      approvalType: "tool_execution",
      toolName: input.toolName,
      arguments: input.arguments,
      riskLevel: decision.riskLevel,
      description: decision.description,
      approvalReason: decision.reason,
      ...(decision.permissionMode ? { permissionMode: decision.permissionMode } : {}),
      ...(decision.reasonCodes.length ? { approvalReasonCodes: decision.reasonCodes } : {}),
      ...(decision.secondaryReasons.length ? { approvalSecondaryReasons: decision.secondaryReasons } : {}),
      ...(decision.approvedExternalPaths.length ? { approvedExternalPaths: decision.approvedExternalPaths } : {}),
      runId: input.ctx.runId ?? undefined,
      taskId: input.ctx.taskId ?? undefined,
      requestId: input.ctx.requestId ?? undefined,
      toolCallId: input.ctx.toolCallId ?? undefined,
      ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
    };
    let resolution;
    try {
      resolution = await deps.pendingInteractions.waitForApproval(pendingRequest);
    } catch (error) {
      if (isAbortError(error) || input.ctx.signal?.aborted) { throw error; }
      return { decision: "deny" as const, reason: `审批流程异常: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!resolution.approved) {
      return { decision: "deny" as const, reason: `工具 ${input.toolName} 执行已被拒绝：${resolution.message || "用户拒绝执行此操作"}` };
    }
    return { decision: "allow" as const, ...(decision.approvedExternalPaths.length ? { approvedPaths: decision.approvedExternalPaths } : {}) };
  });
}

function normalizeRiskLevel(value: string): RiskLevel | undefined {
  if (value === "low" || value === "medium" || value === "high") { return value; }
  return undefined;
}

function requireSessionId(ctx: ToolExecContext): string {
  if (!ctx.sessionId) { throw new Error("审批交互需要 session_id"); }
  return ctx.sessionId;
}
