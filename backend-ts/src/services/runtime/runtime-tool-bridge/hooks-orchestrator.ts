import type { RuntimeToolExecutionContext, ToolExecutionResult } from "../runtime-tool-types.js";
import { isAbortError, throwIfAborted } from "@ragsystem/agent-protocol";
import type { HookRuntimeService, HookResult } from "../hooks/index.js";
import { errorResult } from "./arguments.js";
import { executeToolCall, type PreparedRuntimeTool } from "./prepared.js";
import { toolToDefinition } from "../../../tools/Tool.js";

type ToolHookPhase =
  | "before_permission"
  | "after_permission"
  | "before_execute"
  | "after_execute"
  | "on_error";

type ToolHookEvent = `tool.${ToolHookPhase}`;

/**
 * Hook 编排:持有 hooks 服务,封装工具执行各阶段钩子(before/after_execute、on_error)的运行、
 * 阻断结果构造与数据合并。hooks 为 null 时 enabled=false,bridge 走无钩子快路径。
 * 自 RuntimeToolBridge 迁出,逻辑零改动。
 */
export class ToolHookOrchestrator {
  constructor(private readonly hooks: HookRuntimeService | null) {}

  get enabled(): boolean {
    return this.hooks !== null;
  }

  async runToolHook(
    eventName: ToolHookEvent,
    input: Parameters<HookRuntimeService["runToolHook"]>[1],
  ): Promise<HookResult> {
    return this.hooks
      ? this.hooks.runToolHook(eventName, input)
      : { continueExecution: true, blockExecution: false, blockReason: "" };
  }

  mergeHookData<T>(
    result: ToolExecutionResult<T>,
    hookResult: HookResult | undefined,
    phase: ToolHookPhase,
  ): ToolExecutionResult<T> {
    return hookResult && this.hooks ? this.hooks.mergeHookData(result, hookResult, phase) : result;
  }

  hookBlockedResult(
    toolName: string,
    hookResult: HookResult,
    phase: ToolHookPhase,
  ): ToolExecutionResult<string> {
    const result = errorResult(hookResult.blockReason || "Hook blocked tool execution", toolName, {
      hook_blocked: true,
      hook_phase: phase,
      ...(hookResult.permissionDecision ? { hook_permission_decision: hookResult.permissionDecision } : {}),
    });
    return this.mergeHookData(result, hookResult, phase);
  }

  /** 在 before/after_execute、on_error 钩子包裹下执行工具,并把各阶段权限钩子数据合并进结果。 */
  async executeWithHooks(
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
      let result = await executeToolCall(prepared, context);
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
}
