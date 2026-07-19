/**
 * tool.gate hook（backend）：审批策略判 + ask 时阻塞审批交互 + 路径准入记录。
 *
 * 审批编排从 SDK 内核迁出归 backend；SDK 不再认识审批业务。
 *
 * 读 prepare 派生的 access（ToolAccessDecision：action allow/deny/ask + signals）：
 * - signals.approvalExempt → 跳过审批（交互类工具，如 request_user_input）
 * - signals.candidatePaths → 路径越界候选（policy externalPathCandidates，审批通过 pathService.approve）
 * - action==="ask" → toolAsksApproval（工具声明需审批，如 Bash 高危）
 * ask 时阻塞等用户审批；approve 记录候选路径供工具 call 放行（替代原 ctx.approvedExternalPaths 链）。
 */
import type { HookRegistry, ToolExecContext } from "@ragsystem/agent-sdk";
import { isAbortError, RecoverableInterrupt, throwIfAborted } from "@ragsystem/agent-protocol";
import type { RiskLevel } from "../../../contracts/permissions.js";
import type { PermissionPolicyService, RuntimeToolApprovalInput } from "../../runtime/permission-policy-service.js";
import { resolveInteractionDeadlineMs, type PendingInteractionPort, type PendingApprovalRequest } from "../../../contracts/pending-interactions.js";
import type { PathAccessPolicy } from "../../../contracts/path-access-policy.js";

export interface GateHookDeps {
  permissionPolicy: PermissionPolicyService;
  pendingInteractions: PendingInteractionPort;
  pathService: PathAccessPolicy;
  agentName: string;
}

export function registerGateHook(hooks: HookRegistry, deps: GateHookDeps): void {
  hooks.on("tool.gate", async (input) => {
    const access = input.access;
    const candidatePaths = readCandidatePaths(access?.signals);
    const serviceInput: RuntimeToolApprovalInput = {
      toolName: input.toolName,
      riskLevel: normalizeRiskLevel(input.riskLevel),
      arguments: input.arguments,
      sessionId: input.ctx.sessionId ?? undefined,
      approvalExempt: Boolean(access?.signals?.approvalExempt),
      ...(access?.action === "ask" ? { toolAsksApproval: true } : {}),
      ...(candidatePaths.length ? { externalPathCandidates: candidatePaths } : {}),
    };
    let decision;
    try {
      decision = deps.permissionPolicy.evaluateToolApproval(serviceInput);
    } catch (error) {
      if (isAbortError(error) || input.ctx.signal?.aborted) { throw error; }
      return { decision: "deny" as const, reason: `审批策略异常: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (decision.action === "allow") {
      if (candidatePaths.length) { deps.pathService.approve(candidatePaths); }
      return { decision: "allow" as const };
    }
    // ask：阻塞等用户审批
    throwIfAborted(input.ctx.signal, "Agent run aborted");
    const runContext = requireRunContext(input.ctx);
    const pendingRequest: PendingApprovalRequest = {
      sessionId: requireSessionId(input.ctx),
      runId: runContext.runId,
      rootRunId: runContext.rootRunId,
      parentRunId: runContext.parentRunId,
      parentCallId: runContext.parentCallId,
      toolCallId: runContext.toolCallId,
      ...(input.ctx.interactionBatchId ? { interactionBatchId: input.ctx.interactionBatchId } : {}),
      ...(input.ctx.onInteractionRequired ? { onInteractionRequired: input.ctx.onInteractionRequired } : {}),
      deadlineMs: resolveInteractionDeadlineMs(input.ctx.executionKind),
      task: input.ctx.rootTask ?? "",
      executionKind: input.ctx.executionKind,
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
      ...(candidatePaths.length ? { externalPathCandidates: candidatePaths } : {}),
      taskId: input.ctx.taskId ?? undefined,
      requestId: input.ctx.requestId ?? undefined,
      ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
    };
    let resolution;
    try {
      resolution = await deps.pendingInteractions.waitForApproval(pendingRequest);
    } catch (error) {
      if (isAbortError(error) || input.ctx.signal?.aborted) { throw error; }
      if (error instanceof RecoverableInterrupt) { throw error; }
      return { decision: "deny" as const, reason: `审批流程异常: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!resolution.approved) {
      return { decision: "deny" as const, reason: `工具 ${input.toolName} 执行已被拒绝：${resolution.message || "用户拒绝执行此操作"}` };
    }
    if (candidatePaths.length) { deps.pathService.approve(candidatePaths); }
    return { decision: "allow" as const };
  });
}

function readCandidatePaths(signals: Record<string, unknown> | undefined): string[] {
  const value = signals?.candidatePaths;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeRiskLevel(value: string): RiskLevel | undefined {
  if (value === "low" || value === "medium" || value === "high") { return value; }
  return undefined;
}

function requireSessionId(ctx: ToolExecContext): string {
  if (!ctx.sessionId) { throw new Error("审批交互需要 session_id"); }
  return ctx.sessionId;
}

function requireRunContext(ctx: ToolExecContext): {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  parentCallId: string | null;
  toolCallId: string;
} {
  if (!ctx.runId) { throw new Error("审批交互需要 run_id"); }
  if (!ctx.toolCallId) { throw new Error("审批交互需要 tool_call_id"); }
  return {
    runId: ctx.runId,
    rootRunId: ctx.rootRunId ?? ctx.runId,
    parentRunId: ctx.parentRunId ?? null,
    parentCallId: ctx.runParentCallId ?? null,
    toolCallId: ctx.toolCallId,
  };
}
