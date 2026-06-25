/**
 * ToolProvider 端口默认实现——把内核转交的 calls 喂给 executeToolCallRound。
 *
 * 接收 ToolRegistry（SDK Tool 实例集合）而非 ToolExecutor（已退役）。
 * 透传 hooks / 审批端口 / waitForToolResult，实际编排由 executeToolCallRound 负责。
 */
import type {
  ApprovalInteraction,
  EventSink,
  KernelContext,
  KernelObservation,
  KernelToolCall,
  ToolProvider,
  ToolExecContext,
  PermissionPolicy,
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
  /** 数据根目录（observation artifact 落盘用）。 */
  dataRoot: string;
  /** 实时输出导线：tool_call / tool_result 经它透传到 Dispatcher。 */
  events: EventSink;
  /** 事件 Hook 注册表（tool.before/after/error）。 */
  hooks?: HookRegistry;
  /** 审批策略端口（可选；不注入即全部 allow）。 */
  permissionPolicy?: PermissionPolicy;
  /** 审批交互端口（可选；policy 返回 ask 时阻塞等待）。 */
  approvalInteraction?: ApprovalInteraction;
  /** 后台任务等待回调（消费端注入）。 */
  waitForToolResult?: (request: ToolWaitRequest, ctx: ToolExecContext) => ToolWaitResult | Promise<ToolWaitResult>;
}

export class RuntimeToolProvider implements ToolProvider {
  private readonly registry: ToolRegistry;
  private readonly toolContext: ToolExecContext;
  private readonly dataRoot: string;
  private readonly events: EventSink;
  private readonly hooks: HookRegistry | undefined;
  private readonly permissionPolicy: PermissionPolicy | undefined;
  private readonly approvalInteraction: ApprovalInteraction | undefined;
  private readonly waitForToolResultFn: ((request: ToolWaitRequest, ctx: ToolExecContext) => ToolWaitResult | Promise<ToolWaitResult>) | undefined;

  constructor(options: RuntimeToolProviderOptions) {
    this.registry = options.registry;
    this.toolContext = options.toolContext;
    this.dataRoot = options.dataRoot;
    this.events = options.events;
    this.hooks = options.hooks;
    this.permissionPolicy = options.permissionPolicy;
    this.approvalInteraction = options.approvalInteraction;
    this.waitForToolResultFn = options.waitForToolResult;
  }

  async executeRound(ctx: KernelContext, round: number, calls: KernelToolCall[]): Promise<KernelObservation[]> {
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
      ...(this.permissionPolicy ? { permissionPolicy: this.permissionPolicy } : {}),
      ...(this.approvalInteraction ? { approvalInteraction: this.approvalInteraction } : {}),
      ...(this.waitForToolResultFn ? { waitForToolResult: this.waitForToolResultFn } : {}),
    });
  }
}
