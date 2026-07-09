/** XML 协议解析出的单个工具调用（callId 可选——模型未提供时由协议分配）。 */
export interface ParsedToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
  callId?: string;
}

export interface RuntimeToolCallParseResult {
  calls: ParsedToolCall[];
  error: string | null;
}

const TOOL_PATTERN = /<tool\b([^>]*)>([\s\S]*?)<\/tool>/gi;
const TOOL_PATTERN_UNCLOSED = /<tool\b([^>]*)>([\s\S]*?)(?=<tool\b|<\/(?:tool_calls|tools)>|$)/gi;
const XML_ATTRIBUTE_PATTERN = /([A-Za-z_][\w:-]*)\s*=\s*"([^"]*)"/g;
const CDATA_PATTERN = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/;
const BARE_PLACEHOLDER_PATTERN = /([:\[,]\s*)\{(result_?\d+(?:\.[A-Za-z0-9_.]+)?)\}/gi;

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

  const calls: ParsedToolCall[] = [];
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

    const call: ParsedToolCall = {
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

/**
 * 解析工具参数：整体 JSON 对象（CDATA 已由 unwrapCdata 剥）。
 *
 * 协议教学要求模型把参数作为一个 JSON 对象放进 <tool> 标签内（不按参数名拆成 <param> 标签），
 * 数组/对象/数字类型由 JSON.parse 原生还原（无损）。
 * 多个候选（原样 / 占位符修复 / 反斜杠路径修复 / 提取首层 {}）逐个尝试解析。
 */
function parseToolArguments(content: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!content.trim()) {
    return { ok: true, value: {} };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
