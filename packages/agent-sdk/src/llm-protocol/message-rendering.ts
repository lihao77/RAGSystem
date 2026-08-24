/**
 * 消息渲染（迁自 backend-ts message-builder.ts + 两协议的 toModelMessages）。
 *
 * 两协议的消息渲染统一为按 role 原样发——协议只约束模型**输出**（裸正文 + <tool_calls>），
 * 不包装输入/历史。区别仅在工具调用：xml 用 XML 标签重建（模型不支持厂商 FC），native 直传厂商 FC。
 * 历史语义包装（<user_input>/<assistant_final>/<intent> 等）已移除：无标签化后轮次性质
 * 由 tool_calls 有无表达，正文永远裸文本。user content（含图片 image part）原样直达模型。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";
import { extractText } from "@ragsystem/agent-llm";
import { serializeToolCallsToXml } from "./xml/index.js";

/**
 * XML 模型语境渲染（XmlProtocol.toModelMessages 的单条实现）：
 * - role:tool -> role:user 透传 observation（XML 模型不认 role:tool）。
 * - assistant 带 tool_calls -> 裸正文 + <tool_calls>...</tool_calls>（工具调用用 XML 标签重建）。
 * - 其余（user/assistant 纯文本/system）原样透传——协议只约束输出，user content（含图片）直达模型。
 */
export function renderXmlModelMessage(message: ChatMessage): ChatMessage {
  if (message.role === "tool") {
    return { role: "user", content: message.content };
  }
  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    const text = message.content ? extractText(message.content) : "";
    return { role: "assistant", content: `${text}${serializeToolCallsToXml(message.tool_calls)}` };
  }
  return { ...message };
}

/** Native FC 模型语境渲染：结构化直传（厂商模型原生消费 content + tool_calls + role:tool）。 */
export function renderNativeModelMessage(message: ChatMessage): ChatMessage {
  return { ...message };
}
