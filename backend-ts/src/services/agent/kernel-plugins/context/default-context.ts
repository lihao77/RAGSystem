import type { ChatMessage } from "../../../integrations/llm-chat-client.js";
import type { Context, KernelContext, Protocol, ToolInstructionMode } from "../../kernel/contracts.js";
import { buildRuntimeMessages } from "./message-builder.js";

export interface DefaultContextOptions {
  /** 工具指令形态：决定 buildMessages 是否注入 XML 协议说明。由装配层（selectProtocol）绑定。 */
  toolInstructionMode: ToolInstructionMode;
  /** 协议实例：buildMessages 调其 toModelMessages 渲染会话历史（协议相关的"给模型下发"形态）。 */
  protocol: Protocol;
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
export class DefaultContext implements Context {
  constructor(private readonly options: DefaultContextOptions) {}

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
      renderConversation: (messages) => this.options.protocol.toModelMessages(messages),
    });
  }
}
