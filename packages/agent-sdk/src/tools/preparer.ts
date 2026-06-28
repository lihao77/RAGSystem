/**
 * 工具准备阶段——校验 + 权限自检。
 *
 * prepare 的产出 PreparedTool 携带已校验的 input + 权限信号（checkAccess 的 ToolAccessDecision），
 * 供 tool-round-executor 的审批编排和执行阶段使用。路径越界候选等业务信号经 access.signals 透传。
 */
import type { ToolExecContext, ToolExecutionResult } from "../contracts.js";
import type { Tool, ToolAccessDecision } from "./tool.js";
import type { ToolRegistry } from "./registry.js";
import { validateToolInput } from "./validation.js";
import { buildToolExecutionErrorResult } from "./tool-references.js";

export interface PreparedTool<I = Record<string, unknown>> {
  tool: Tool<I>;
  input: I;
  permission: ToolAccessDecision | null;
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

  // 委托工具：跳过本地 inputSchema 校验 + checkAccess（执行在宿主前端，后端不重复校验）
  if (tool.delegateToHost) {
    return { ok: true, prepared: { tool, input: args, permission: null } };
  }

  // 3. 输入校验
  const validation = validateToolInput(tool as Tool<Record<string, unknown>>, args);
  if (!validation.ok) {
    return { ok: false, result: validation.result };
  }
  const input = validation.input;

  // 4. 工具访问检查（自检 + 审批声明）
  let permission: ToolAccessDecision | null = null;
  if (tool.checkAccess) {
    permission = tool.checkAccess(input, ctx);
    if (permission.action === "deny") {
      return {
        ok: false,
        result: permission.result ?? buildToolExecutionErrorResult(toolName, new Error(permission.reason)),
      };
    }
    // 把 access.signals（如 Bash 的 bash_plan）附到 input——不可枚举，供 tool.call 读取但不污染 LLM 可见参数。
    attachAccessSignals(input, permission);
  }

  return {
    ok: true,
    prepared: { tool, input, permission },
  };
}

/**
 * 把 access.signals 附到 input——不可枚举，供 tool.call 读取但不污染 LLM 可见参数。
 * 约定：signals 的顶层键作为 input 上的 `__runtime_<key>` 附加属性。
 */
function attachAccessSignals(input: Record<string, unknown>, access: ToolAccessDecision): void {
  const signals = access.signals;
  if (!signals || typeof signals !== "object") { return; }
  for (const [key, value] of Object.entries(signals)) {
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
