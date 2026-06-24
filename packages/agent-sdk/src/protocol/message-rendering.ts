/**
 * 消息渲染（迁自 backend-ts message-builder.ts + 两协议的 toModelMessages）。
 *
 * 两个 Protocol 实现共用同一渲染逻辑，避免散落副本：
 * - renderSemanticChatMessage：把结构化 ChatMessage 包进语义 XML 块（<user_input>/<assistant_final> 等）。
 * - renderXmlModelMessage：XML 模型语境——role:tool -> role:user，assistant+tool_calls -> <intent><tool_calls> XML。
 * - renderNativeModelMessage：FC 直传（厂商模型原生消费 content + tool_calls + role:tool）。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";
import { isSemanticTaggedContent, renderSemanticBlock, serializeToolCallsToXml } from "./xml/index.js";

/** 把单条结构化 ChatMessage 包进语义块（已语义标签的直传）。 */
export function renderSemanticChatMessage(message: ChatMessage): ChatMessage {
  if (isSemanticTaggedContent(message.content)) {
    return { ...message };
  }
  if (message.role === "user") {
    return {
      ...message,
      content: renderSemanticBlock("user_input", message.content, { source: "conversation" }),
    };
  }
  if (message.role === "assistant") {
    return {
      ...message,
      content: renderSemanticBlock("assistant_final", message.content, { source: "conversation" }),
    };
  }
  if (message.role === "tool") {
    return {
      ...message,
      content: renderSemanticBlock("tool_result", message.content, {
        source: "native_tool_message",
        call_id: message.tool_call_id ?? "",
        name: message.name ?? "",
      }),
    };
  }
  // system
  return { ...message, content: renderSemanticBlock("system_instruction", message.content, { source: "agent_config" }) };
}

/**
 * XML 模型语境渲染（XmlProtocol.toModelMessages 的单条实现）：
 * - role:tool -> role:user 透传 observation 文本（XML 模型不认 role:tool）。
 * - assistant 带 tool_calls -> <intent>content</intent><tool_calls>...</tool_calls>（从结构化字段重建）。
 * - 其余沿用 renderSemanticChatMessage 的语义包装。
 */
export function renderXmlModelMessage(message: ChatMessage): ChatMessage {
  if (message.role === "tool") {
    return { role: "user", content: message.content };
  }
  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    const intent = message.content ? renderSemanticBlock("intent", message.content) : "";
    return { role: "assistant", content: `${intent}${serializeToolCallsToXml(message.tool_calls)}` };
  }
  return renderSemanticChatMessage(message);
}

/** Native FC 模型语境渲染：结构化直传（厂商模型原生消费）。 */
export function renderNativeModelMessage(message: ChatMessage): ChatMessage {
  return { ...message };
}
