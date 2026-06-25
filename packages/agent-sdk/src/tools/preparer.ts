/**
 * 工具准备阶段——校验 + 权限自检 + 路径收集。
 *
 * prepare 的产出 PreparedTool 携带已校验的 input + 权限信号，
 * 供 tool-round-executor 的审批编排和执行阶段使用。
 */
import type { ToolExecContext, ToolExecutionResult } from "../contracts.js";
import type { Tool, ToolPermissionResult } from "./tool.js";
import type { ToolRegistry } from "./registry.js";
import { validateToolInput } from "./validation.js";
import { buildToolExecutionErrorResult } from "./tool-references.js";

export interface PreparedTool<I = Record<string, unknown>> {
  tool: Tool<I>;
  input: I;
  permission: ToolPermissionResult | null;
  approvedExternalPaths: string[];
}

export type PrepareResult<I = Record<string, unknown>> =
  | { ok: true; prepared: PreparedTool<I> }
  | { ok: false; result: ToolExecutionResult };

export interface ToolPreparerOptions {
  registry: ToolRegistry;
}

export function prepareTool(
  options: ToolPreparerOptions,
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): PrepareResult {
  const { registry } = options;

  // 1. 查找工具
  const tool = registry.getTool(toolName);
  if (!tool) {
    return {
      ok: false,
      result: buildToolExecutionErrorResult(toolName, new Error(`工具 ${toolName} 不存在或当前不可用`)),
    };
  }

  // 2. 检查调用者准入
  const caller = ctx.caller ?? "direct";
  if (!tool.allowedCallers.includes(caller)) {
    return {
      ok: false,
      result: buildToolExecutionErrorResult(toolName, new Error(`工具 ${toolName} 不允许 ${caller} 调用`)),
    };
  }

  // 3. 输入校验
  const validation = validateToolInput(tool as Tool<Record<string, unknown>>, args);
  if (!validation.ok) {
    return { ok: false, result: validation.result };
  }
  const input = validation.input;

  // 4. 工具级权限自检
  let permission: ToolPermissionResult | null = null;
  if (tool.checkPermissions) {
    permission = tool.checkPermissions(input, ctx);
    if (permission.behavior === "deny") {
      return {
        ok: false,
        result: permission.result ?? buildToolExecutionErrorResult(toolName, new Error(permission.reason ?? `工具 ${toolName} 权限拒绝`)),
      };
    }
    // 把 checkPermissions 的 runtimeData（如 Bash 的 bash_plan）附到 input——不可枚举，
    // 供 tool.call 读取但不污染 LLM 可见的参数。
    attachPermissionRuntimeData(input, permission);
  }

  // 5. 路径收集
  const approvedExternalPaths = tool.getExternalPathApprovalCandidates?.(input, ctx) ?? [];

  return {
    ok: true,
    prepared: { tool, input, permission, approvedExternalPaths },
  };
}

/**
 * 把 checkPermissions 的 runtimeData 附到 input——不可枚举，供 tool.call 读取但不污染 LLM 可见的参数。
 * 约定：permission.metadata 的顶层键作为 input 上的 `__runtime_<key>` 附加属性。
 */
function attachPermissionRuntimeData(input: Record<string, unknown>, permission: ToolPermissionResult): void {
  const metadata = permission.metadata;
  if (!metadata || typeof metadata !== "object") { return; }
  for (const [key, value] of Object.entries(metadata)) {
    const runtimeKey = `__runtime_${key}`;
    if (!(runtimeKey in input)) {
      Object.defineProperty(input, runtimeKey, {
        value,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }
}
