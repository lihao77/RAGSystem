import type { RiskLevel } from "../../../contracts/permissions.js";
import type { HookResult } from "../hooks/index.js";
import type { RuntimeToolApprovalDecision } from "../permission-policy-service.js";
import type { ToolExecutionResult } from "../runtime-tool-types.js";
import { errorResult } from "../runtime-tool-bridge/arguments.js";
import type { RuntimeToolPermissionResult } from "./tool.js";

export function denyPermissionResult(
  toolName: string,
  permission: RuntimeToolPermissionResult,
): ToolExecutionResult<string> {
  return errorResult(permission.reason ?? `工具 ${toolName} 被权限策略拒绝`, toolName, {
    tool_permission: {
      behavior: permission.behavior,
      reason: permission.reason ?? "",
      ...(permission.metadata ?? {}),
    },
  });
}

export function isToolPermissionForceAsk(permission: RuntimeToolPermissionResult | null): boolean {
  return permission?.behavior === "ask";
}

export function mergeToolPermissionMetadata(
  metadata: Record<string, unknown>,
  permission: RuntimeToolPermissionResult | null,
): Record<string, unknown> {
  if (!permission) {
    return metadata;
  }
  return {
    ...metadata,
    tool_permission: {
      behavior: permission.behavior,
      reason: permission.reason ?? "",
      ...(permission.metadata ?? {}),
    },
  };
}

export function applyHookPermissionDecision(
  decision: RuntimeToolApprovalDecision | undefined,
  hookResult: HookResult,
  toolName: string,
  riskLevel: RiskLevel | undefined,
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

function buildHookApprovalDecision(toolName: string, riskLevel: RiskLevel | undefined): RuntimeToolApprovalDecision {
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
