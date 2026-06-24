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
const OPEN_TAG_PATTERN = /<([^/>\s!][^>\s]*)([^>]*)>/g;
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

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    return value.slice(1, -1);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
