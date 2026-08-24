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
 * 无标签化：正文是裸文本（流式呈现给用户），唯一结构化标签是 <tool_calls>；
 * 轮次性质由 runtime 判定——有 tool_calls 即工具轮，纯文本即最终回答。
 */
export function renderRuntimeXmlProtocolInstruction(tools: RuntimeToolDefinition[]): string {
  const protocol = [
    "Your visible reply is plain text streamed to the user as you write it. Write it in the user's language, do not expose hidden reasoning.",
    "When you need a tool, put the invocation in a <tool_calls> block. Text outside <tool_calls> in that round is a short natural language action note for the user; keep it brief.",
    "When the task is complete, reply with the final answer as plain text, without any tool_calls block.",
    'To embed a durable workspace file in the final answer, use the exact self-closing <file_ref path="relative/path" presentation="inline|attachment|preview" caption="optional label"/> tag. Plain "File: ..." text, Markdown links, and attachment prose are not file references. Only use a real workspace-relative path returned by a tool; copy transient or external output into workspace before referencing it.',
    'Choose presentation by purpose: "inline" embeds the file content directly in the reply (small images, short code/text, small tables); "preview" shows a compact card the user clicks to open a full-size viewer (large images, charts, reports, PDF/HTML documents); "attachment" offers the file as a download without rendering its content (deliverables, datasets, archives).',
    'For interactive charts, first write an ECharts option JSON file (e.g. trend.echarts.json: {"renderer":"echarts","option":{...}} with series type limited to line/bar/pie/scatter), then reference it with presentation "inline" so it renders as an interactive chart; static chart images should stay as regular image files.',
    "Never wrap your reply in phase tags (intent, final_answer, answer, and the like); plain text is the answer itself.",
    "Preferred tool call format (arguments as a single JSON object inside the tool tag):",
    '<tool_calls><tool name="tool_name"><![CDATA[{ "param1": value1, "param2": value2 }]]></tool></tool_calls>',
    "The JSON object must conform to the tool's parameter schema. Array/object/number types are preserved as-is by JSON parsing.",
    "Use CDATA when the JSON contains XML-sensitive characters (<, >, &) to avoid breaking the tool tag.",
    "Multiple independent tool calls can be placed in the same <tool_calls> block; calls are numbered by position within the block (1-based).",
    "A later call may chain an earlier call's result with {result_N} or {result_N.path}; the runtime runs a dependent call after the call it references, so keep the referenced call above it. Never reference a result defined later in the block.",
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
 * Native（FC）协议说明：工具走厂商 function calling，正文是裸文本。
 * 无标签化：不再教 <intent>/<final_answer> 阶段标签；工具轮的 FC 调用
 * 与纯文本最终回答由 runtime 依据 toolCalls 有无判定。
 * 不含 tool_manifest——工具 schema 由 request.tools 经厂商 FC 下发。
 */
export function renderNativeXmlProtocolInstruction(): string {
  const protocol = [
    "You call tools via native function calling. Your text output never carries tool invocation.",
    "Your visible reply is plain text streamed to the user as you write it. Write it in the user's language, do not expose hidden reasoning.",
    "When calling a tool, any text in the same round is a short natural language action note for the user; keep it brief.",
    "When the task is complete, reply with the final answer as plain text, without calling any tool.",
    'To embed a durable workspace file in the final answer, use the exact self-closing <file_ref path="relative/path" presentation="inline|attachment|preview" caption="optional label"/> tag. Plain "File: ..." text, Markdown links, and attachment prose are not file references. Only use a real workspace-relative path returned by a tool; copy transient or external output into workspace before referencing it.',
    'Choose presentation by purpose: "inline" embeds the file content directly in the reply (small images, short code/text, small tables); "preview" shows a compact card the user clicks to open a full-size viewer (large images, charts, reports, PDF/HTML documents); "attachment" offers the file as a download without rendering its content (deliverables, datasets, archives).',
    'For interactive charts, first write an ECharts option JSON file (e.g. trend.echarts.json: {"renderer":"echarts","option":{...}} with series type limited to line/bar/pie/scatter), then reference it with presentation "inline" so it renders as an interactive chart; static chart images should stay as regular image files.',
    "Tool parameters are supplied through function calling; never serialize them as XML text.",
    "Never wrap your reply in phase tags (intent, final_answer, answer, and the like); plain text is the answer itself.",
  ].join("\n");

  return renderSemanticBlock("runtime_instruction", protocol, {
    source: "ts_runtime",
    kind: "native_xml_protocol",
  });
}

/** 协议修复反馈消息（tool_calls 解析失败/空响应后追加进 messages 要求模型重试）。 */
export function renderProtocolFeedbackMessage(error: string, attempt: number, maxAttempts: number): ChatMessage {
  const feedback = [
    `The previous assistant output could not be parsed by the runtime protocol: ${error}`,
    `Repair attempt ${attempt}/${maxAttempts}. Regenerate this round only.`,
    "Output exactly one of these forms:",
    "a short action note followed by <tool_calls><tool name=\"tool_name\"><![CDATA[{ ... }]]></tool></tool_calls>",
    "or the final answer as plain text with no tool_calls block.",
    "Never wrap your reply in phase tags (intent, final_answer, answer).",
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
