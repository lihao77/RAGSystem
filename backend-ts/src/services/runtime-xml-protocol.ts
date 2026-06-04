import type { ChatMessage } from "./llm-chat-client.js";
import type { ToolExecutionResult } from "./memory-tool-service.js";
import type { RuntimeToolCall, RuntimeToolDefinition } from "./runtime-tool-types.js";

export type RuntimeXmlTag = "intent" | "tool_calls" | "final_answer";

export interface RuntimeXmlParseEvent {
  type: "tag_open" | "content" | "tag_close";
  tag: RuntimeXmlTag;
  content: string;
}

export interface RuntimeToolCallParseResult {
  calls: RuntimeToolCall[];
  error: string | null;
}

const TAG_ALIASES: Record<string, RuntimeXmlTag> = {
  intent: "intent",
  tool_calls: "tool_calls",
  tools: "tool_calls",
  final_answer: "final_answer",
  answer: "final_answer",
};

const TOOL_PATTERN = /<tool\b([^>]*)>([\s\S]*?)<\/tool>/gi;
const TOOL_PATTERN_UNCLOSED = /<tool\b([^>]*)>([\s\S]*?)(?=<tool\b|<\/(?:tool_calls|tools)>|$)/gi;
const XML_ATTRIBUTE_PATTERN = /([A-Za-z_][\w:-]*)\s*=\s*"([^"]*)"/g;
const OPEN_TAG_PATTERN = /<([^/>\s!][^>\s]*)([^>]*)>/g;
const CDATA_PATTERN = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/;
const BARE_PLACEHOLDER_PATTERN = /([:\[,]\s*)\{(result_?\d+(?:\.[A-Za-z0-9_.]+)?)\}/gi;

export class StreamingRuntimeXmlParser {
  private state: RuntimeXmlTag | null = null;
  private buffer = "";
  private fullResponse = "";
  private readonly tagContents: Record<RuntimeXmlTag, string> = {
    intent: "",
    tool_calls: "",
    final_answer: "",
  };

  feed(chunk: string): RuntimeXmlParseEvent[] {
    if (!chunk) {
      return [];
    }
    this.fullResponse += chunk;
    this.buffer += chunk;
    const events: RuntimeXmlParseEvent[] = [];

    while (this.buffer) {
      const consumed = this.state === null ? this.scanForOpenTag(events) : this.scanForCloseTag(events);
      if (!consumed) {
        break;
      }
    }

    return events;
  }

  getFullResponse(): string {
    return this.fullResponse;
  }

  getTagContent(tag: RuntimeXmlTag): string {
    return this.tagContents[tag];
  }

  get currentState(): RuntimeXmlTag | null {
    return this.state;
  }

  private scanForOpenTag(events: RuntimeXmlParseEvent[]): boolean {
    const ltPos = this.buffer.indexOf("<");
    if (ltPos === -1) {
      return false;
    }
    if (ltPos > 0) {
      this.buffer = this.buffer.slice(ltPos);
    }

    const gtPos = this.buffer.indexOf(">");
    if (gtPos === -1) {
      return false;
    }

    const rawTag = this.buffer.slice(1, gtPos).trim().toLowerCase();
    const tagName = rawTag.split(/\s+/, 1)[0] ?? "";
    const matchedTag = TAG_ALIASES[tagName];
    this.buffer = this.buffer.slice(gtPos + 1);
    if (!matchedTag) {
      return true;
    }

    this.state = matchedTag;
    events.push({ type: "tag_open", tag: matchedTag, content: "" });
    return true;
  }

  private scanForCloseTag(events: RuntimeXmlParseEvent[]): boolean {
    if (this.state === null) {
      return false;
    }

    const closeMatch = this.findCloseTagMatch(this.state);
    if (closeMatch) {
      const [closePos, closeTag] = closeMatch;
      const contentBefore = this.buffer.slice(0, closePos);
      if (contentBefore) {
        this.tagContents[this.state] += contentBefore;
        if (this.state === "intent" || this.state === "final_answer") {
          events.push({ type: "content", tag: this.state, content: contentBefore });
        }
      }
      events.push({ type: "tag_close", tag: this.state, content: "" });
      this.buffer = this.buffer.slice(closePos + closeTag.length);
      this.state = null;
      return true;
    }

    const safeLength = this.findSafeContentLength();
    if (safeLength > 0) {
      const content = this.buffer.slice(0, safeLength);
      this.tagContents[this.state] += content;
      if (this.state === "intent" || this.state === "final_answer") {
        events.push({ type: "content", tag: this.state, content });
      }
      this.buffer = this.buffer.slice(safeLength);
      return true;
    }

    return false;
  }

  private findCloseTagMatch(tag: RuntimeXmlTag): [number, string] | null {
    const matches: Array<[number, string]> = [];
    for (const closeTag of closeTagsForTag(tag)) {
      const closePos = this.buffer.toLowerCase().indexOf(closeTag);
      if (closePos !== -1) {
        matches.push([closePos, closeTag]);
      }
    }
    matches.sort((left, right) => left[0] - right[0]);
    return matches[0] ?? null;
  }

  private findSafeContentLength(): number {
    if (!this.buffer) {
      return 0;
    }
    const maxCloseLength = 18;
    const checkStart = Math.max(0, this.buffer.length - maxCloseLength);
    const tail = this.buffer.slice(checkStart);
    const lastLt = tail.lastIndexOf("<");
    if (lastLt === -1) {
      return this.buffer.length;
    }

    const partial = tail.slice(lastLt).toLowerCase();
    for (const closeTag of allCloseTags()) {
      if (closeTag.startsWith(partial)) {
        return checkStart + lastLt;
      }
    }
    return this.buffer.length;
  }
}

export function parseRuntimeToolCallsXml(content: string): RuntimeToolCallParseResult {
  if (!content.trim()) {
    return { calls: [], error: "empty tool_calls content" };
  }

  let matches = collectToolMatches(content, TOOL_PATTERN);
  if (matches.length === 0) {
    matches = collectToolMatches(content, TOOL_PATTERN_UNCLOSED);
  }
  if (matches.length === 0) {
    return { calls: [], error: `no valid <tool> tag found: ${content.slice(0, 200)}` };
  }

  const calls: RuntimeToolCall[] = [];
  const errors: string[] = [];
  for (const match of matches) {
    const attrs = extractAttributes(match.attrs);
    const toolName = attrs.name?.trim() ?? "";
    if (!toolName) {
      errors.push("tool tag is missing name attribute");
      continue;
    }

    const rawArguments = unwrapCdata(match.content.trim());
    const parsedArguments = parseToolArguments(rawArguments);
    if (!parsedArguments.ok) {
      errors.push(`tool '${toolName}' argument parse failed: ${parsedArguments.error}`);
      continue;
    }

    const call: RuntimeToolCall = {
      toolName,
      arguments: parsedArguments.value,
    };
    if (attrs.id?.trim()) {
      call.callId = attrs.id.trim();
    }
    calls.push(call);
  }

  return {
    calls,
    error: errors.length > 0 ? errors.join("; ") : null,
  };
}

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

export function renderToolResultMessage(input: {
  callId: string;
  toolName: string;
  result: ToolExecutionResult;
}): ChatMessage {
  return {
    role: "user",
    content: renderToolResultContent(input),
  };
}

export function renderToolResultContent(input: {
  callId: string;
  toolName: string;
  result: ToolExecutionResult;
}): string {
  const semantic = inferToolResultSemantic(input.toolName, input.result);
  return renderSemanticBlock("tool_result", renderCompactToolObservation(input.result), {
    id: input.callId,
    name: input.toolName,
    ok: input.result.success ? "true" : "false",
    ...(semantic ? { semantic } : {}),
  });
}

export function renderSemanticBlock(tagName: string, content: string, attributes: Record<string, string> = {}): string {
  const renderedAttributes = Object.entries(attributes)
    .filter(([, value]) => value.trim())
    .map(([key, value]) => ` ${key}="${escapeXmlAttribute(value)}"`)
    .join("");
  return `<${tagName}${renderedAttributes}>${wrapCdata(content)}</${tagName}>`;
}

export function isSemanticTaggedContent(content: string): boolean {
  return /^<([A-Za-z_][\w:-]*)(\s[^>]*)?>[\s\S]*<\/\1>\s*$/.test(content.trim());
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

function renderCompactToolObservation(result: ToolExecutionResult): string {
  if (!result.success) {
    return JSON.stringify({
      error: stringifyToolContent(result.content) || result.summary,
      retryable: false,
    });
  }

  const preferredContent = result.llm_hint?.trim() || result.answer?.trim() || result.content;
  const source = getObservationSource(result.metadata);
  if (typeof preferredContent === "string") {
    if (source && result.tool_name === "read_memory_entry") {
      return JSON.stringify({
        content: preferredContent,
        source,
      });
    }
    return preferredContent;
  }
  if (preferredContent !== null && preferredContent !== undefined) {
    const payload = source && isRecord(preferredContent)
      ? { ...preferredContent, source }
      : preferredContent;
    return JSON.stringify(payload);
  }
  return result.summary;
}

function inferToolResultSemantic(toolName: string, result: ToolExecutionResult): string | null {
  const semantic = result.metadata.semantic;
  if (typeof semantic === "string" && semantic.trim()) {
    return semantic.trim();
  }
  return toolName === "request_user_input" ? "user_input_response" : null;
}

function getObservationSource(metadata: Record<string, unknown>): string | null {
  for (const key of ["file_path", "index_file_path", "source", "path"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  const scope = metadata.scope;
  return typeof scope === "string" && scope.trim() ? scope.trim() : null;
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function collectToolMatches(content: string, pattern: RegExp): Array<{ attrs: string; content: string }> {
  pattern.lastIndex = 0;
  const matches: Array<{ attrs: string; content: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    matches.push({
      attrs: match[1] ?? "",
      content: match[2] ?? "",
    });
  }
  return matches;
}

function parseToolArguments(content: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!content.trim()) {
    return { ok: true, value: {} };
  }

  const xmlArguments = tryParseXmlArguments(content);
  if (xmlArguments) {
    return { ok: true, value: xmlArguments };
  }

  const jsonCandidates = [
    content,
    fixBarePlaceholders(content),
    fixBackslashPaths(content),
    extractJsonObject(content),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of jsonCandidates) {
    const parsed = tryParseJsonObject(candidate);
    if (parsed) {
      return { ok: true, value: parsed };
    }
  }

  return { ok: false, error: content.slice(0, 120) };
}

function tryParseXmlArguments(content: string): Record<string, unknown> | null {
  const fields = extractTopLevelXmlFields(content);
  if (fields.length === 0) {
    return null;
  }

  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name === "arguments") {
      result[field.name] = parseListValue(field.value);
      continue;
    }
    result[field.name] = field.cdata ? field.value : coerceXmlValue(field.value.trim());
    if ((field.name === "file_path" || field.name === "working_dir") && field.attributes.space) {
      result[`${field.name}_space`] = field.attributes.space;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function extractTopLevelXmlFields(content: string): Array<{
  name: string;
  value: string;
  attributes: Record<string, string>;
  cdata: boolean;
}> {
  const results: Array<{ name: string; value: string; attributes: Record<string, string>; cdata: boolean }> = [];
  OPEN_TAG_PATTERN.lastIndex = 0;
  let position = 0;

  while (position < content.length) {
    OPEN_TAG_PATTERN.lastIndex = position;
    const match = OPEN_TAG_PATTERN.exec(content);
    if (!match) {
      break;
    }

    const name = (match[1] ?? "").trim();
    const attributes = extractAttributes(match[2] ?? "");
    const contentStart = match.index + match[0].length;
    const closeTag = `</${name}>`;
    const openTagForDepth = new RegExp(`<${escapeRegExp(name)}(?:\\s[^>]*)?>`, "g");
    let searchPosition = contentStart;
    let depth = 1;
    let found = false;

    while (depth > 0 && searchPosition < content.length) {
      const closePosition = content.indexOf(closeTag, searchPosition);
      if (closePosition === -1) {
        break;
      }

      openTagForDepth.lastIndex = searchPosition;
      let nested: RegExpExecArray | null;
      while ((nested = openTagForDepth.exec(content)) !== null && nested.index < closePosition) {
        depth += 1;
      }

      depth -= 1;
      if (depth === 0) {
        const value = content.slice(contentStart, closePosition);
        const cdata = CDATA_PATTERN.exec(value);
        results.push({
          name,
          attributes,
          value: cdata?.[1] ?? value,
          cdata: Boolean(cdata),
        });
        position = closePosition + closeTag.length;
        found = true;
        break;
      }

      searchPosition = closePosition + closeTag.length;
    }

    if (!found) {
      position = contentStart;
    }
  }

  return results;
}

function parseListValue(value: string): string[] {
  const itemPattern = /<item>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/item>|<item>([\s\S]*?)<\/item>/g;
  const items: string[] = [];
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemPattern.exec(value)) !== null) {
    const raw = itemMatch[1] ?? itemMatch[2] ?? "";
    const normalized = stripWrappingQuotes(raw.trim());
    if (normalized) {
      items.push(normalized);
    }
  }
  if (items.length > 0) {
    return items;
  }

  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item));
      }
    } catch {
      // fall through
    }
  }

  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function coerceXmlValue(value: string): unknown {
  const lower = value.toLowerCase();
  if (lower === "true") {
    return true;
  }
  if (lower === "false") {
    return false;
  }
  if (lower === "null" || lower === "none") {
    return null;
  }
  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    return Number.parseFloat(value);
  }
  if (value.startsWith("{") || value.startsWith("[")) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function tryParseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
    return { value: parsed };
  } catch {
    return null;
  }
}

function extractJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }
  return null;
}

function fixBarePlaceholders(value: string): string {
  return value.replace(BARE_PLACEHOLDER_PATTERN, '$1"{$2}"');
}

function fixBackslashPaths(value: string): string {
  const legalEscapes = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character === "\\" && index + 1 < value.length) {
      const nextCharacter = value[index + 1] ?? "";
      if (!legalEscapes.has(nextCharacter)) {
        result += "/";
        continue;
      }
    }
    result += character;
  }
  return result;
}

function extractAttributes(rawAttributes: string): Record<string, string> {
  XML_ATTRIBUTE_PATTERN.lastIndex = 0;
  const attrs: Record<string, string> = {};
  let match: RegExpExecArray | null;
  while ((match = XML_ATTRIBUTE_PATTERN.exec(rawAttributes)) !== null) {
    const key = match[1]?.trim();
    const value = match[2]?.trim();
    if (key && value !== undefined) {
      attrs[key] = value;
    }
  }
  return attrs;
}

function unwrapCdata(value: string): string {
  const match = CDATA_PATTERN.exec(value);
  return match?.[1]?.trim() ?? value;
}

function wrapCdata(value: string): string {
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    return value.slice(1, -1);
  }
  return value;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function closeTagsForTag(tag: RuntimeXmlTag): string[] {
  if (tag === "final_answer") {
    return ["</final_answer>", "</answer>"];
  }
  if (tag === "tool_calls") {
    return ["</tool_calls>", "</tools>"];
  }
  return ["</intent>"];
}

function allCloseTags(): string[] {
  return ["</intent>", "</tool_calls>", "</tools>", "</final_answer>", "</answer>"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
