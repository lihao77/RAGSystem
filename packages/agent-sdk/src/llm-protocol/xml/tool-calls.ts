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
/** 组合修复候选的规模上限——防御性兜底，正常输入远小于此。 */
const MAX_ARGUMENT_PARSE_CANDIDATES = 64;

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
 * 多个候选（原样 / 各修复单独应用 / 各修复组合应用）逐个尝试解析。
 */
function parseToolArguments(content: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!content.trim()) {
    return { ok: true, value: {} };
  }

  for (const candidate of buildArgumentParseCandidates(content)) {
    const parsed = tryParseJsonObject(candidate);
    if (parsed) {
      return { ok: true, value: parsed };
    }
  }

  return { ok: false, error: content.slice(0, 120) };
}

/**
 * 闭包式组合各修复生成解析候选：同一参数可能同时存在多种格式瑕疵（如字符串内字面换行 +
 * 裸 {result_N} 占位符、非法反斜杠路径、JSON 外层文本），只做单次独立修复会漏掉组合场景。
 * 每个修复幂等（对已修复输入返回自身），BFS 层数有限，候选集有界。
 */
function buildArgumentParseCandidates(content: string): string[] {
  const seen = new Set<string>([content]);
  const queue = [content];
  const fixes = [
    fixBarePlaceholders,
    escapeRawControlCharacters,
    fixBackslashPaths,
    extractJsonObject,
  ];
  while (queue.length > 0 && seen.size < MAX_ARGUMENT_PARSE_CANDIDATES) {
    const current = queue.shift()!;
    for (const fix of fixes) {
      const candidate = fix(current);
      if (candidate && candidate !== current && !seen.has(candidate)) {
        seen.add(candidate);
        queue.push(candidate);
      }
    }
  }
  return [...seen];
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

/**
 * 修复模型在 JSON 字符串值里写入的**字面**换行/制表符（在 CDATA 中合法，但 JSON.parse 会拒绝）。
 * 编辑工具的多行代码（old_string/new_string 带缩进）常见此形态：严格解析失败后，
 * 把字符串字面量内的原始控制字符转义为 \n/\r/\t，缩进空格原样保留，再交给 JSON.parse 还原。
 * 只处理字符串内部——字符串外的控制字符本就是合法空白。
 */
function escapeRawControlCharacters(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (inString) {
      if (escaped) {
        result += character;
        escaped = false;
        continue;
      }
      if (character === "\\") {
        result += character;
        escaped = true;
        continue;
      }
      if (character === '"') {
        result += character;
        inString = false;
        continue;
      }
      if (character === "\n") {
        result += "\\n";
        continue;
      }
      if (character === "\r") {
        result += "\\r";
        continue;
      }
      if (character === "\t") {
        result += "\\t";
        continue;
      }
      result += character;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    result += character;
  }
  return result;
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
