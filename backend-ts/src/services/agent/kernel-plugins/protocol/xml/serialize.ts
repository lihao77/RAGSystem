import type { ChatToolCall } from "../../../../integrations/llm-chat-client.js";
import { escapeXmlAttribute } from "./rendering.js";

/**
 * 结构化 tool_calls → XML 序列化（parseRuntimeToolCallsXml 的逆）。
 *
 * 阶段3统一消息合约后，XML 协议的工具调用以结构化 ChatMessage.tool_calls 存储（与 FC 同形态）。
 * XML toModelMessages 在回填给模型时，用它把结构化字段重建为
 * `<tool_calls><tool name=".."><param>value</param></tool></tool_calls>` XML 文本——
 * 与模型当前轮输出的格式（rendering.ts 协议说明）一致，保证模型回看历史无割裂。
 */
export function serializeToolCallsToXml(toolCalls: ChatToolCall[]): string {
  if (toolCalls.length === 0) {
    return "";
  }
  const tools = toolCalls.map(serializeToolCallToXml).join("");
  return `<tool_calls>${tools}</tool_calls>`;
}

function serializeToolCallToXml(call: ChatToolCall): string {
  const args = parseArgumentsObject(call.function.arguments);
  const params = Object.entries(args)
    .map(([key, value]) => serializeParam(key, value))
    .join("");
  return `<tool name="${escapeXmlAttribute(call.function.name)}">${params}</tool>`;
}

function serializeParam(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => `<item>${toXmlText(item)}</item>`)
      .join("");
    return `<${key}>${items}</${key}>`;
  }
  return `<${key}>${toXmlText(value)}</${key}>`;
}

function toXmlText(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value === null || value === undefined) {
    return "";
  } else if (typeof value === "object") {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }
  return needsCdata(text) ? wrapCdata(text) : text;
}

function needsCdata(text: string): boolean {
  return /[<>&]/.test(text);
}

function wrapCdata(text: string): string {
  return `<![CDATA[${text.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

function parseArgumentsObject(raw: string): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 非法 JSON → 空参数
  }
  return {};
}
