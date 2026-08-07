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
    'Inside <final_answer>, embed a durable workspace file only with the exact self-closing <file_ref path="relative/path" presentation="inline|attachment|preview" caption="optional label"/> tag. Plain "File: ..." text, Markdown links, and attachment prose are not file references. Only use workspace-relative paths returned by tools.',
    "Do not mix <final_answer> with <tool_calls> in the same round.",
    "Preferred tool call format (arguments as a single JSON object inside the tool tag):",
    '<tool_calls><tool name="tool_name"><![CDATA[{ "param1": value1, "param2": value2 }]]></tool></tool_calls>',
    "The JSON object must conform to the tool's parameter schema. Array/object/number types are preserved as-is by JSON parsing.",
    "Use CDATA when the JSON contains XML-sensitive characters (<, >, &) to avoid breaking the tool tag.",
    "Multiple independent tool calls can be placed in the same <tool_calls> block.",
    "Within a single round, reference the Nth tool's result with {result_N} (1-based) to chain calls.",
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
    'Inside <final_answer>, embed a durable workspace file only with the exact self-closing <file_ref path="relative/path" presentation="inline|attachment|preview" caption="optional label"/> tag. Plain "File: ..." text, Markdown links, and attachment prose are not file references. Only use workspace-relative paths returned by tools.',
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

/**
 * 语义块：把内容包进带属性的 XML 标签。
 * 默认内容无条件 CDATA（服务工具产出等不可控内容）；conditionalCdata:true 时仅含 XML 特殊字符才包，
 * 供模型生成的短文本（如 intent）与 instruction 教导形态对齐，避免历史冒出无条件 CDATA 误导模型输出。
 */
export function renderSemanticBlock(
  tagName: string,
  content: string,
  attributes: Record<string, string> = {},
  options: { conditionalCdata?: boolean } = {},
): string {
  const renderedAttributes = Object.entries(attributes)
    .filter(([, value]) => value.trim())
    .map(([key, value]) => ` ${key}="${escapeXmlAttribute(value)}"`)
    .join("");
  const body = options.conditionalCdata ? wrapCdataIfNeeded(content) : wrapCdata(content);
  return `<${tagName}${renderedAttributes}>${body}</${tagName}>`;
}

/** 含 XML 特殊字符（< > &）才 CDATA 包裹，否则原样；CDATA 自身的 ]]> 由 wrapCdata 内部拆分处理。 */
function wrapCdataIfNeeded(content: string): string {
  return needsXmlEscape(content) ? wrapCdata(content) : content;
}

function needsXmlEscape(text: string): boolean {
  return /[<>&]/.test(text);
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
