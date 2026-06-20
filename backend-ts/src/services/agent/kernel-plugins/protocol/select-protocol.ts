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

import type { LlmChatClient } from "../../../integrations/llm-chat-client.js";
import { OPENAI_COMPATIBLE_TYPES } from "../../../integrations/llm-chat-client.js";
import type { ModelProviderConfig } from "../../../../contracts/model-adapter.js";
import type { EventSink, Protocol, ToolInstructionMode } from "../../kernel/contracts.js";
import { NativeHybridProtocol } from "./native-hybrid-protocol.js";
import { XmlProtocol } from "./xml-protocol.js";

export interface SelectProtocolDeps {
  provider: ModelProviderConfig;
  llmChatClient: LlmChatClient;
  events: EventSink;
}

export interface SelectedProtocol {
  protocol: Protocol;
  toolInstructionMode: ToolInstructionMode;
}

export function selectProtocol(deps: SelectProtocolDeps): SelectedProtocol {
  const { provider, llmChatClient, events } = deps;
  const providerType = provider.provider_type;

  // anthropic 原生 tool_use，无视 supports_function_calling 标注。
  if (providerType === "anthropic") {
    return { protocol: new NativeHybridProtocol(llmChatClient, events), toolInstructionMode: "native" };
  }

  // OpenAI 兼容 + 显式 supports_function_calling=true → native FC。
  // supports_function_calling 未标注（undefined）或 false → 保守回退 XML（等价阶段一行为）。
  if (OPENAI_COMPATIBLE_TYPES.has(providerType) && provider.supports_function_calling === true) {
    return { protocol: new NativeHybridProtocol(llmChatClient, events), toolInstructionMode: "native" };
  }

  // 默认：XML 内容协议。
  return { protocol: new XmlProtocol(llmChatClient, events), toolInstructionMode: "xml" };
}
