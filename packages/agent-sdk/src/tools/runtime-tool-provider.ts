/**
 * ToolProvider 端口默认实现（迁自 backend-ts runtime-tool-provider.ts）。
 *
 * 薄适配：把内核转交来的 calls 喂给 executeToolCallRound（单轮编排引擎），EventSink 注回去
 * 使 tool_call/tool_result 不脱钩。本类不碰 calls 构造（Protocol 负责）也不碰 observation
 * 渲染（executeToolCallRound 内部负责）。
 *
 * 事件边界：tool_call/tool_result 在 executeToolCallRound 内 emit（经注入的 EventSink）；
 * observation_complete 不在本类（Kernel 在 appendMessages 后 emit）；assistant_intermediate 在 Kernel/Protocol 侧。
 */
import type { EventSink, KernelContext, KernelObservation, KernelToolCall, ToolProvider, ToolExecutor, ToolExecContext } from "../contracts.js";
import { executeToolCallRound } from "./tool-round-executor.js";

export interface RuntimeToolProviderOptions {
  /** 工具执行端口（消费端实现）。 */
  toolExecutor: ToolExecutor;
  /** 工具执行上下文模板（sessionId/runId/taskId 等运行时元数据）。 */
  toolContext: ToolExecContext;
  /** 数据根目录（observation artifact 落盘用）。 */
  dataRoot: string;
  /** 实时输出导线：tool_call / tool_result 经它透传到 Dispatcher。 */
  events: EventSink;
}

export class RuntimeToolProvider implements ToolProvider {
  private readonly toolExecutor: ToolExecutor;
  private readonly toolContext: ToolExecContext;
  private readonly dataRoot: string;
  private readonly events: EventSink;

  constructor(options: RuntimeToolProviderOptions) {
    this.toolExecutor = options.toolExecutor;
    this.toolContext = options.toolContext;
    this.dataRoot = options.dataRoot;
    this.events = options.events;
  }

  async executeRound(ctx: KernelContext, round: number, calls: KernelToolCall[]): Promise<KernelObservation[]> {
    const session = ctx.session;
    return executeToolCallRound(calls, {
      toolExecutor: this.toolExecutor,
      toolContext: this.toolContext,
      dataRoot: this.dataRoot,
      round,
      agentName: session.profile.agentName,
      profile: session.profile,
      provider: session.provider,
      events: this.events,
    });
  }
}
