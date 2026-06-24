import type {
  RuntimeToolCall,
  RuntimeToolExecutionContext,
  ToolExecutionResult,
} from "../runtime-tool-types.js";
import { throwIfAborted } from "@ragsystem/agent-protocol";
import {
  buildToolCallContext,
  dedupeStrings,
  errorResult,
} from "./arguments.js";
import type { RuntimeToolRegistry } from "../../../tools/registry.js";
import { type RuntimeTool, type RuntimeToolPermissionResult } from "../../../tools/Tool.js";
import { validateToolInput } from "../../../tools/validation.js";
import { denyPermissionResult } from "../../../tools/permissions.js";

/** 一次工具调用经校验/权限自检后的就绪态(供审批与执行阶段消费)。 */
export type PreparedRuntimeTool = {
  call: RuntimeToolCall;
  context: RuntimeToolExecutionContext;
  toolName: string;
  tool: RuntimeTool<Record<string, unknown>>;
  input: Record<string, unknown>;
  caller: string;
  toolPermission: RuntimeToolPermissionResult | null;
  approvedExternalPaths: string[];
};

/** prepare 的结果:就绪态,或已可直接返回的错误/拒绝结果。 */
export type PreparedResult = PreparedRuntimeTool | ToolExecutionResult;

export function isToolResult(value: unknown): value is ToolExecutionResult {
  return isRecord(value) && typeof value.success === "boolean" && typeof value.tool_name === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

/** 实际调起工具(执行前再查一次 abort)。审批后/无 hook 两条路径共用。 */
export function executeToolCall(
  prepared: PreparedRuntimeTool,
  context: RuntimeToolExecutionContext,
): ToolExecutionResult | Promise<ToolExecutionResult> {
  throwIfAborted(context.signal, "Tool execution aborted");
  return prepared.tool.call(prepared.input, context);
}

/**
 * 工具准备:解析可见工具、caller 准入、入参校验、工具级权限自检、外部路径候选汇总。
 * 自 RuntimeToolBridge.prepareToolExecution 原样迁出,逻辑零改动。
 */
export class ToolPreparer {
  constructor(private readonly registry: RuntimeToolRegistry) {}

  prepare(call: RuntimeToolCall, context: RuntimeToolExecutionContext): PreparedResult {
    const executionContext = buildToolCallContext(call, {
      ...context,
      caller: context.caller ?? "direct",
    });
    const toolName = call.toolName.trim();
    const tool = this.registry.getVisibleTool(toolName, executionContext.agent) as RuntimeTool<Record<string, unknown>> | null;
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
}
