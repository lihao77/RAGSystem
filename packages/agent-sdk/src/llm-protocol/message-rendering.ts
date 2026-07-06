/**
 * 消息渲染（迁自 backend-ts message-builder.ts + 两协议的 toModelMessages）。
 *
 * 两协议的消息渲染统一为按 role 原样发——XML 协议只约束模型**输出**（<intent>/<tool_calls>/<final_answer>），
 * 不包装输入/历史。区别仅在工具调用：xml 用 XML 标签重建（模型不支持厂商 FC），native 直传厂商 FC。
 * 历史语义包装（<user_input>/<assistant_final> 等）已移除：它们多余且 <assistant_final> 与输出协议
 * <final_answer> 语义撞车。user content（含图片 image part）原样直达模型。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";
import { extractText } from "@ragsystem/agent-llm";
import { renderSemanticBlock, serializeToolCallsToXml } from "./xml/index.js";

/**
 * XML 模型语境渲染（XmlProtocol.toModelMessages 的单条实现）：
 * - role:tool -> role:user 透传 observation（XML 模型不认 role:tool）。
 * - assistant 带 tool_calls -> <intent>content</intent><tool_calls>...</tool_calls>（工具调用用 XML 标签重建）。
 * - 其余（user/assistant 纯文本/system）原样透传——XML 协议只约束输出，user content（含图片）直达模型。
 */
export function renderXmlModelMessage(message: ChatMessage): ChatMessage {
  if (message.role === "tool") {
    return { role: "user", content: message.content };
  }
  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    // intent 按需 CDATA：短句通常无 XML 特殊字符，与 instruction 教模型输出 `<intent>note</intent>` 形态一致，
    // 避免历史回填冒出无条件 CDATA 让模型困惑/模仿（tool_calls 参数本就按需 CDATA，intent 对齐之）。
    const intent = message.content ? renderSemanticBlock("intent", extractText(message.content), {}, { conditionalCdata: true }) : "";
    return { role: "assistant", content: `${intent}${serializeToolCallsToXml(message.tool_calls)}` };
  }
  return { ...message };
}

/** Native FC 模型语境渲染：结构化直传（厂商模型原生消费 content + tool_calls + role:tool）。 */
export function renderNativeModelMessage(message: ChatMessage): ChatMessage {
  return { ...message };
}
