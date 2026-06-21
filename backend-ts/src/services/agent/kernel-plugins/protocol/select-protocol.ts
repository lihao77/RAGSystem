/**
 * 协议选择器（kernel-plugins/protocol）。
 *
 * 阶段二：按 provider_type + supports_function_calling 分派到 NativeHybridProtocol / XmlProtocol。
 * - anthropic：原生 tool_use，无视 supports_function_calling 标注 → NativeHybridProtocol (native)。
 * - OpenAI 兼容（OPENAI_COMPATIBLE_TYPES）+ supports_function_calling === true → NativeHybridProtocol (native)。
 * - 其余 / supports_function_calling 未标注或 false → XmlProtocol (xml)，保守回退等价阶段一行为。
 *
 * 探查修正 plan：原拟 OpenAiHybridProtocol / AnthropicHybridProtocol 两协议，但 llm-chat-client
 * 已抽象厂商（流式都吐统一 ChatToolCall；buildAnthropicBody 补 tool_use/tool_result 转换），
 * 故 native FC 只需一个 NativeHybridProtocol，厂商差异下沉到 llm-chat-client。
 *
 * toolInstructionMode 随协议形态产出（native=不注入 XML 说明走厂商 FC；xml=注入 XML 协议说明），
 * 由 createRuntimeKernel 绑进 Context 实例，不渗进内核。
 */

import type { ChatMessage, LlmChatClient } from "../../../integrations/llm-chat-client.js";
import { OPENAI_COMPATIBLE_TYPES } from "../../../integrations/provider-registry.js";
import type { ModelProviderConfig } from "../../../../contracts/model-adapter.js";
import type { EventSink, Protocol, ToolInstructionMode } from "../../kernel/contracts.js";
import { NativeHybridProtocol } from "./native-hybrid-protocol.js";
import { XmlProtocol, renderXmlModelMessage } from "./xml-protocol.js";

export interface SelectProtocolDeps {
  provider: ModelProviderConfig;
  llmChatClient: LlmChatClient;
  events: EventSink;
}

export interface SelectedProtocol {
  protocol: Protocol;
  toolInstructionMode: ToolInstructionMode;
}

/**
 * 由 provider 配置解析工具指令形态（与 selectProtocol 同一矩阵，纯函数）。
 * 供展示/估算场景复用（context-snapshot、token 估算）——它们不构造 Protocol，只需知道用哪种提示词。
 */
export function resolveToolInstructionMode(provider: ModelProviderConfig): ToolInstructionMode {
  // anthropic 原生 tool_use，无视 supports_function_calling 标注。
  if (provider.provider_type === "anthropic") {
    return "native";
  }
  // OpenAI 兼容 + 显式 supports_function_calling=true → native FC。
  // supports_function_calling 未标注（undefined）或 false → 保守回退 XML（等价阶段一行为）。
  if (OPENAI_COMPATIBLE_TYPES.has(provider.provider_type) && provider.supports_function_calling === true) {
    return "native";
  }
  return "xml";
}

export function selectProtocol(deps: SelectProtocolDeps): SelectedProtocol {
  const toolInstructionMode = resolveToolInstructionMode(deps.provider);
  const protocol = toolInstructionMode === "native"
    ? new NativeHybridProtocol(deps.llmChatClient, deps.events)
    : new XmlProtocol(deps.llmChatClient, deps.events);
  return { protocol, toolInstructionMode };
}

/**
 * 按 provider 渲染会话历史成"模型实际收到的形态"(与 selectProtocol 同一矩阵,纯函数)。
 * native → 结构化直传;xml → renderXmlModelMessage 序列化。供 monitoring/调试视图复用,
 * 避免外层裸 import xml-protocol 内部函数。与两个 Protocol.toModelMessages 逐字等价。
 */
export function renderMessagesForProvider(provider: ModelProviderConfig | null, messages: ChatMessage[]): ChatMessage[] {
  return provider && resolveToolInstructionMode(provider) === "native"
    ? messages.map((message) => ({ ...message }))
    : messages.map(renderXmlModelMessage);
}
