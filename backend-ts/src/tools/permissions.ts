import type { ToolExecutionResult } from "../services/runtime/runtime-tool-types.js";
import { errorResult } from "../services/runtime/runtime-tool-bridge/arguments.js";
import type { RuntimeToolPermissionResult } from "./Tool.js";

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
