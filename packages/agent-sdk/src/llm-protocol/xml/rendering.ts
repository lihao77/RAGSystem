/**
 * XML 协议渲染助手（迁自 backend-ts protocol/xml/rendering.ts）。
 *
 * 只保留协议端口需要的渲染逻辑：语义块构造、协议说明注入、tool_manifest、修复反馈。
 * 重型 tool-result observation 渲染（renderCompactToolObservation/renderBashToolObservation 等）
 * 不迁——SDK 的 KernelObservation 已带预计算 observation 字符串（ToolProvider 职责），
 * 协议 renderObservations 直接用 observation.observation。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";
import type { RuntimeToolDefinition } from "../../prompt/tool-types.js";

/**
 * 完整 XML 协议说明 + tool_manifest（注入 system message）。
 * XML 模式工具不走厂商 FC，模型靠 manifest 知道有哪些工具、参数 schema。
 */
export function renderRuntimeXmlProtocolInstruction(tools: RuntimeToolDefinition[]): string {
  const protocol = [
    "You must output runtime XML phases, without Markdown fences.",
    "Use <intent> only for a short natural language action note visible to the user. Do not expose hidden reasoning.",
    "Use <tool_calls> when a tool is needed. Tool calls are hidden from the user and parsed by the runtime.",
    "Use <final_answer> only when the task is complete. The final answer is the only assistant message persisted as the final response.",
    "Do not mix <final_answer> with <tool_calls> in the same round.",
    "Preferred tool call format:",
    '<tool_calls><tool name="tool_name"><param_name>value</param_name></tool></tool_calls>',
    "Use CDATA for multiline text or content containing XML-sensitive characters.",
    "Legacy aliases <tools> and <answer> are accepted, but prefer <tool_calls> and <final_answer>.",
  ].join("\n");

  return [
    renderSemanticBlock("runtime_instruction", protocol, {
      source: "ts_runtime",
      kind: "xml_protocol",
    }),
    renderToolManifest(tools),
  ].join("\n\n");
}

/**
 * Native（FC）+ XML content 混合协议说明：工具走厂商 function calling，content 仍用
 * <intent>/<final_answer> XML 阶段（供 runtime 解析出 intent 事件链）。
 * 不含 tool_manifest——工具 schema 由 request.tools 经厂商 FC 下发。
 */
export function renderNativeXmlProtocolInstruction(): string {
  const protocol = [
    "You call tools via native function calling. Your text output never carries tool invocation.",
    "Your text output uses runtime XML phases for content only, without Markdown fences.",
    "Use <intent> only for an optional short natural language action note visible to the user when calling a tool. Do not expose hidden reasoning.",
    "Use <final_answer> only when the task is complete. The final answer is the only assistant message persisted as the final response.",
    "Tool parameters are supplied through function calling; never serialize them as XML text.",
  ].join("\n");

  return renderSemanticBlock("runtime_instruction", protocol, {
    source: "ts_runtime",
    kind: "native_xml_protocol",
  });
}

/** 协议修复反馈消息（XML 解析失败后追加进 messages 要求模型重试）。 */
export function renderProtocolFeedbackMessage(error: string, attempt: number, maxAttempts: number): ChatMessage {
  const feedback = [
    `The previous assistant output could not be parsed by the runtime XML protocol: ${error}`,
    `Repair attempt ${attempt}/${maxAttempts}. Regenerate this round only.`,
    "Output exactly one of these forms:",
    "<intent>short visible action note</intent><tool_calls>...</tool_calls>",
    "<final_answer>final answer</final_answer>",
    "Do not explain the protocol error.",
  ].join("\n");

  return {
    role: "user",
    content: renderSemanticBlock("protocol_feedback", feedback, {
      source: "runtime",
      attempt: String(attempt),
      max_attempts: String(maxAttempts),
    }),
  };
}

/** 语义块：把内容包进带属性的 XML 标签，内容用 CDATA 安全包裹。 */
export function renderSemanticBlock(tagName: string, content: string, attributes: Record<string, string> = {}): string {
  const renderedAttributes = Object.entries(attributes)
    .filter(([, value]) => value.trim())
    .map(([key, value]) => ` ${key}="${escapeXmlAttribute(value)}"`)
    .join("");
  return `<${tagName}${renderedAttributes}>${wrapCdata(content)}</${tagName}>`;
}

/** 内容是否已被语义标签包裹（避免重复包装）。 */
export function isSemanticTaggedContent(content: string): boolean {
  return /^<([A-Za-z_][\w:-]*)(\s[^>]*)?>[\s\S]*<\/\1>\s*$/.test(content.trim());
}

/** XML 属性转义。 */
export function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderToolManifest(tools: RuntimeToolDefinition[]): string {
  const renderedTools = tools
    .map((tool) =>
      [
        `<tool name="${escapeXmlAttribute(tool.name)}">`,
        renderSemanticBlock("description", tool.description),
        renderSemanticBlock("parameters", JSON.stringify(tool.parameters, null, 2), { format: "json_schema" }),
        "</tool>",
      ].join("\n"),
    )
    .join("\n");
  return `<tool_manifest>\n${renderedTools}\n</tool_manifest>`;
}

function wrapCdata(value: string): string {
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}
