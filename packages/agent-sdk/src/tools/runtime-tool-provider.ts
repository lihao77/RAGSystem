/**
 * ToolProvider 端口默认实现——把内核转交的 calls 喂给 executeToolCallRound。
 *
 * 接收 ToolRegistry（SDK Tool 实例集合）而非 ToolExecutor（已退役）。
 * 透传 hooks / waitForToolResult，实际编排由 executeToolCallRound 负责。
 * permission 经 tool.gate handler 实现（由 createRuntime 在 hooks 上注册），不再经此透传。
 */
import type {
  EventSink,
  KernelContext,
  KernelObservation,
  KernelToolCall,
  ToolProvider,
  ToolExecContext,
  ToolExecutionResult,
  ToolWaitRequest,
  ToolWaitResult,
} from "../contracts.js";
import type { HookRegistry } from "../hooks/types.js";
import type { ToolRegistry } from "./registry.js";
import { executeToolCallRound } from "./tool-round-executor.js";

export interface RuntimeToolProviderOptions {
  /** 工具注册表（SDK 定义的 Tool 实例集合）。 */
  registry: ToolRegistry;
  /** 工具执行上下文模板（sessionId/runId/taskId 等运行时元数据）。 */
  toolContext: ToolExecContext;
  /** 数据根目录（工具媒体读取等宿主资源使用；大结果临时文件由 observation 写入 os.tmpdir）。 */
  dataRoot: string;
  /** 实时输出导线：tool_call / tool_result 经它透传到 Dispatcher。 */
  events: EventSink;
  /** 事件 Hook 注册表（tool.before/gate/after/error）。 */
  hooks?: HookRegistry;
  /** 后台任务等待回调（消费端注入）。 */
  waitForToolResult?: (request: ToolWaitRequest, ctx: ToolExecContext) => ToolWaitResult | Promise<ToolWaitResult>;
}

export class RuntimeToolProvider implements ToolProvider {
  private readonly registry: ToolRegistry;
  private readonly toolContext: ToolExecContext;
  private readonly dataRoot: string;
  private readonly events: EventSink;
  private readonly hooks: HookRegistry | undefined;
  private readonly waitForToolResultFn: ((request: ToolWaitRequest, ctx: ToolExecContext) => ToolWaitResult | Promise<ToolWaitResult>) | undefined;

  constructor(options: RuntimeToolProviderOptions) {
    this.registry = options.registry;
    this.toolContext = options.toolContext;
    this.dataRoot = options.dataRoot;
    this.events = options.events;
    this.hooks = options.hooks;
    this.waitForToolResultFn = options.waitForToolResult;
  }

  async executeRound(
    ctx: KernelContext,
    round: number,
    calls: KernelToolCall[],
    previousResults: ReadonlyMap<number, ToolExecutionResult> = new Map(),
  ): Promise<KernelObservation[]> {
    const session = ctx.session;
    return executeToolCallRound(calls, {
      registry: this.registry,
      toolContext: this.toolContext,
      dataRoot: this.dataRoot,
      round,
      agentName: session.profile.agentName,
      profile: session.profile,
      provider: session.provider,
      events: this.events,
      ...(this.hooks ? { hooks: this.hooks } : {}),
      ...(this.waitForToolResultFn ? { waitForToolResult: this.waitForToolResultFn } : {}),
    }, previousResults);
  }
}
