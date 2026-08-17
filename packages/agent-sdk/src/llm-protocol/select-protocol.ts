/**
 * 协议选择器（迁自 backend-ts select-protocol.ts）。
 *
 * 按 provider_type + supports_function_calling 分派到 NativeHybridProtocol / XmlProtocol：
 * - anthropic：原生 tool_use -> NativeHybridProtocol (native)。
 * - OpenAI Responses / OpenAI 兼容 + supports_function_calling === true -> NativeHybridProtocol (native)。
 * - 其余 / supports_function_calling 未标注或 false -> XmlProtocol (xml)，保守回退。
 *
 * toolInstructionMode 随协议形态产出，由 createRuntime 绑进 Context（prompt 按模式注入不同说明）。
 */
import { providerUsesNativeFunctionCalling } from "@ragsystem/agent-llm";
import type { ProviderConfig } from "@ragsystem/agent-llm";
import type { LlmClient } from "@ragsystem/agent-llm";
import type { EventSink, Protocol, ToolInstructionMode } from "../contracts.js";
import type { RuntimeToolDefinition } from "../prompt/tool-types.js";
import { NativeHybridProtocol } from "./native-hybrid-protocol.js";
import { XmlProtocol } from "./xml-protocol.js";

/** 协议工厂依赖。 */
export interface ProtocolFactoryOptions {
  /** provider 可缺（preview 无 tier 场景）；缺省按 xml 协议。 */
  provider: ProviderConfig | null | undefined;
  llm: LlmClient;
  events: EventSink;
  /** 工具定义来源（默认空——工具执行层尚未接入）。 */
  getTools?: () => RuntimeToolDefinition[];
}

export interface SelectedProtocol {
  protocol: Protocol;
  toolInstructionMode: ToolInstructionMode;
}

/** 由 provider 配置解析工具指令形态（纯函数，供 prompt 估算场景复用）。provider 缺省（preview 无 tier）回退 xml。 */
export function resolveToolInstructionMode(provider: ProviderConfig | null | undefined): ToolInstructionMode {
  if (!provider) {
    return "xml";
  }
  if (providerUsesNativeFunctionCalling(provider.provider_type, provider.supports_function_calling)) {
    return "native";
  }
  return "xml";
}

/** 按 provider 自动选择协议 + 工具指令形态。 */
export function createProtocol(options: ProtocolFactoryOptions): SelectedProtocol {
  const toolInstructionMode = resolveToolInstructionMode(options.provider);
  const getTools = options.getTools ?? (() => []);
  const protocol = toolInstructionMode === "native"
    ? new NativeHybridProtocol({ llm: options.llm, events: options.events, getTools })
    : new XmlProtocol({ llm: options.llm, events: options.events, getTools });
  return { protocol, toolInstructionMode };
}
