/**
 * 工具执行端口默认实现（kernel-plugins/tools）。
 *
 * 设计（铁律：行为零变化）：
 * - 本类只做一件事：把内核转交来的 calls 喂给 executeToolCallRound（该函数不动，
 *   现位于本目录 tool-round-executor.ts），并把 EventSink 注回去，
 *   使 runtime.tool_call / runtime.tool_result 两事件不脱钩。
 * - 关键事实：executeToolCallRound 内部（executeSingleToolCall L144 / L187）已逐字发射
 *   runtime.tool_call（执行前）与 runtime.tool_result（执行后），字段一字不改。因此本类
 *   不再重复 emit——只把 EventSink.emit 作为 onEvent 注入即可，避免双发 / 字段漂移。
 * - 后台 waitForToolResult 分支：完全保留在 tool-round-executor.resolveToolObservation
 *   （L294-346）内部，本类不感知、不拆分。dataRoot 同样原样透传，供 buildLlmFacingToolResult
 *   等使用。
 *
 * 职责边界：本类只做“调用 executeToolCallRound + onEvent 接线”，不碰 calls 的构造
 * （那由 Protocol 在 parse 阶段产出的 KernelToolCall[] 负责，形状已对齐 PreparedRoundToolCall）。
 *
 * 事件边界：observation_complete 不在本类——它由 XmlProtocol 的 renderObservations 负责；
 * assistant_intermediate 同样在 Protocol/内核侧。
 */

import type {
  EventSink,
  KernelContext,
  KernelObservation,
  KernelToolCall,
  ToolProvider,
} from "../../kernel/contracts.js";
import { executeToolCallRound } from "./tool-round-executor.js";

export interface RuntimeToolProviderOptions {
  /**
   * 数据根目录，对齐现状 AgentRuntimeCore.dataRoot（构造期 `options.dataRoot ?? ~/.ragsystem`）。
   * 透传给 executeToolCallRound，供 observation 物化等使用。本类不在此默认，由上层（runtime-container）
   * 按现状规则解析后注入，保持“行为零变化”。
   */
  dataRoot: string;
  /** 实时输出导线：tool_call / tool_result 经它透传到 publishRuntimeEvent。 */
  events: EventSink;
}

export class RuntimeToolProvider implements ToolProvider {
  private readonly dataRoot: string;
  private readonly events: EventSink;

  constructor(options: RuntimeToolProviderOptions) {
    this.dataRoot = options.dataRoot;
    this.events = options.events;
  }

  async executeRound(
    ctx: KernelContext,
    round: number,
    calls: KernelToolCall[],
  ): Promise<KernelObservation[]> {
    const { toolExecutor, toolContext, agent, provider } = ctx.session;
    // 现状 runXmlToolCallingText / runToolCallingText 进入此分支前已保证 toolExecutor /
    // toolContext 存在（shouldRunXmlToolLoop / shouldRunToolLoop 把守）。内核仅在
    // outcome.kind === "tool_calls" && calls.length 时调用本方法，calls 非空 ⇒ 必有工具执行器。
    if (!toolExecutor || !toolContext) {
      throw new Error(
        `RuntimeToolProvider: tool execution unavailable for agent "${agent.agent_name}"`,
      );
    }

    return executeToolCallRound({
      input: {
        agent,
        provider,
        // tool-round-executor 内部只发 tool_call / tool_result 两类事件（ToolRoundRuntimeEvent，
        // AgentRuntimeEvent 的子集）。EventSink.emit 接收全集，可安全作为更窄类型的回调注入
        // （协变/逆变方向：能处理全集者必能处理子集）。
        onEvent: (event) => this.events.emit(event),
      },
      toolExecutor,
      toolContext,
      dataRoot: this.dataRoot,
      round,
      calls,
    });
  }
}
