import type { ChatMessage } from "../../../integrations/llm-chat-client.js";
import type { Context, KernelContext, ToolInstructionMode } from "../../kernel/contracts.js";
import { buildRuntimeMessages } from "./message-builder.js";

export interface RuntimeContextOptions {
  /** 工具指令形态：决定 buildMessages 是否注入 XML 协议说明。由装配层（selectProtocol）绑定。 */
  toolInstructionMode: ToolInstructionMode;
}

/**
 * Context port 默认实现（kernel-plugins/context）。
 *
 * 接管原 Protocol.buildRequest 的"消息组装"职责：把会话累积（ctx.messages）加工成发给
 * 模型的请求消息（system prompt + stable context + 协议说明 + conversation 渲染）。
 * 请求壳（model/provider/temperature/signal）下沉到 Protocol.buildRequestShell。
 *
 * visibleTools 探测 + promptContext 合并原在 XmlProtocol.buildRequest，整体迁入此处。
 * toolInstructionMode="native" 时跳过 XML 协议说明注入（走厂商 FC，Phase 2.3+）。
 */
export class RuntimeContext implements Context {
  constructor(private readonly options: RuntimeContextOptions) {}

  buildMessages(ctx: KernelContext): ChatMessage[] {
    const session = ctx.session;
    const visibleTools =
      session.toolExecutor && session.toolContext
        ? session.toolExecutor.listVisibleTools(session.agent)
        : [];
    const promptContext = {
      ...(session.promptContext ?? {}),
      tools: session.promptContext?.tools ?? visibleTools,
    };
    return buildRuntimeMessages(session.agent, ctx.messages, {
      xmlProtocolTools: visibleTools,
      promptContext,
      toolInstructionMode: this.options.toolInstructionMode,
    });
  }
}
