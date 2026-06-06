import type {
  ChatCompletionResult,
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
} from "../llm-chat-client.js";
import type { ToolExecutionResult } from "../memory-tool-service.js";
import type { RuntimeToolDefinition } from "../runtime-tool-types.js";

export function toChatToolDefinition(tool: RuntimeToolDefinition): ChatToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

export function buildAssistantToolCallMessage(result: ChatCompletionResult, toolCalls: ChatToolCall[]): ChatMessage {
  return {
    role: "assistant",
    content: result.content,
    tool_calls: toolCalls,
  };
}

export function renderNativeAssistantIntermediateContent(
  result: ChatCompletionResult,
  toolCalls: ChatToolCall[],
): string {
  const content = result.content.trim();
  const toolXml = renderNativeToolCallsXml(toolCalls);
  if (content && toolXml) {
    return `${content}\n\n${toolXml}`;
  }
  return content || toolXml;
}

function renderNativeToolCallsXml(toolCalls: ChatToolCall[]): string {
  const tools = toolCalls
    .map((toolCall) => {
      const toolName = toolCall.function.name || "unknown_tool";
      const args = parseToolArguments(toolCall);
      const params = Object.entries(args).map(([key, value]) => renderXmlParameter(key, value)).join("\n");
      return [`<tool name="${escapeXmlAttribute(toolName)}">`, params, "</tool>"].filter(Boolean).join("\n");
    })
    .join("\n");
  return tools ? `<tool_calls>\n${tools}\n</tool_calls>` : "";
}

function renderXmlParameter(key: string, value: unknown): string {
  const safeKey = /^[A-Za-z_][\w:-]*$/.test(key) ? key : "param";
  if (Array.isArray(value)) {
    const items = value.map((item) => `  <item>${escapeXmlText(renderArgumentValue(item))}</item>`).join("\n");
    return `<${safeKey}>\n${items}\n</${safeKey}>`;
  }
  return `<${safeKey}>${escapeXmlText(renderArgumentValue(value))}</${safeKey}>`;
}

function renderArgumentValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return stringifyJsonPretty(value);
}

export function parseToolArguments(toolCall: ChatToolCall): Record<string, unknown> {
  const raw = toolCall.function.arguments.trim();
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return {
      _raw_arguments: raw,
    };
  }
}

const RESULT_REFERENCE_PATTERN = /\{result_?(\d+)(?:\.([A-Za-z0-9_.]+))?\}/gi;
const EXACT_RESULT_REFERENCE_PATTERN = /^\{result_?(\d+)(?:\.([A-Za-z0-9_.]+))?\}$/i;

export function resolveToolArgumentReferences(
  value: Record<string, unknown>,
  results: Map<number, ToolExecutionResult>,
): Record<string, unknown> {
  const resolved = resolveReferenceValue(value, results);
  return isRecord(resolved) ? resolved : value;
}

function resolveReferenceValue(value: unknown, results: Map<number, ToolExecutionResult>): unknown {
  if (typeof value === "string") {
    return resolveReferenceString(value, results);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveReferenceValue(item, results));
  }
  if (isRecord(value)) {
    const resolved: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      resolved[key] = resolveReferenceValue(item, results);
    }
    return resolved;
  }
  return value;
}

function resolveReferenceString(value: string, results: Map<number, ToolExecutionResult>): unknown {
  const exact = EXACT_RESULT_REFERENCE_PATTERN.exec(value);
  if (exact) {
    const reference = resolveReferenceMatch(exact, results);
    return reference.resolved ? reference.value : value;
  }

  RESULT_REFERENCE_PATTERN.lastIndex = 0;
  return value.replace(RESULT_REFERENCE_PATTERN, (placeholder, rawIndex: string, path: string | undefined) => {
    const reference = resolveResultReference(Number.parseInt(rawIndex, 10), path ?? null, results, placeholder);
    return reference.resolved ? stringifyReferenceValue(reference.value) : placeholder;
  });
}

function resolveReferenceMatch(
  match: RegExpExecArray,
  results: Map<number, ToolExecutionResult>,
): { resolved: true; value: unknown } | { resolved: false } {
  const rawIndex = match[1];
  if (!rawIndex) {
    return { resolved: false };
  }
  return resolveResultReference(Number.parseInt(rawIndex, 10), match[2] ?? null, results, match[0]);
}

function resolveResultReference(
  index: number,
  path: string | null,
  results: Map<number, ToolExecutionResult>,
  placeholder: string,
): { resolved: true; value: unknown } | { resolved: false } {
  const result = results.get(index);
  if (!result) {
    return { resolved: false };
  }
  if (!path) {
    return { resolved: true, value: result.content };
  }

  const materialized = materializeToolResult(result);
  const resolved = resolveDottedPath(materialized, path, true);
  if (resolved.found) {
    return { resolved: true, value: resolved.value };
  }
  if ("content" in materialized) {
    const contentResolved = resolveDottedPath(materialized.content, path, true);
    if (contentResolved.found) {
      return { resolved: true, value: contentResolved.value };
    }
  }
  return {
    resolved: true,
    value: {
      __ref_error__: "path_not_found",
      placeholder,
      available_keys: collectAvailableKeys(materialized, path),
    },
  };
}

export function materializeToolResult(result: ToolExecutionResult): Record<string, unknown> {
  return {
    success: result.success,
    tool_name: result.tool_name,
    summary: result.summary,
    answer: result.answer,
    output_type: result.output_type,
    content: result.content,
    metadata: result.metadata,
    artifacts: result.artifacts,
    ...(result.success ? {} : { error: stringifyReferenceValue(result.content) || result.summary }),
  };
}

function resolveDottedPath(
  value: unknown,
  dottedPath: string,
  caseInsensitive: boolean,
): { found: true; value: unknown } | { found: false } {
  let current = value;
  for (const rawKey of dottedPath.split(".")) {
    if (isRecord(current)) {
      if (rawKey in current) {
        current = current[rawKey];
        continue;
      }
      if (caseInsensitive) {
        const lowered = rawKey.toLowerCase();
        const matchedKey = Object.keys(current).find((key) => key.toLowerCase() === lowered);
        if (matchedKey !== undefined) {
          current = current[matchedKey];
          continue;
        }
      }
      return { found: false };
    }
    if (Array.isArray(current)) {
      const index = Number.parseInt(rawKey, 10);
      if (Number.isInteger(index) && index >= 0 && index < current.length) {
        current = current[index];
        continue;
      }
      return { found: false };
    }
    return { found: false };
  }
  return { found: true, value: current };
}

function collectAvailableKeys(value: unknown, dottedPath: string): string[] {
  let current = value;
  for (const rawKey of dottedPath.split(".")) {
    if (isRecord(current)) {
      if (rawKey in current) {
        current = current[rawKey];
        continue;
      }
      return Object.keys(current).slice(0, 10);
    }
    if (Array.isArray(current)) {
      const index = Number.parseInt(rawKey, 10);
      if (Number.isInteger(index) && index >= 0 && index < current.length) {
        current = current[index];
        continue;
      }
      return [`list(len=${current.length})`];
    }
    return [`type=${typeof current}`];
  }
  return [];
}

function stringifyReferenceValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function collectResultPlaceholders(value: unknown): string[] {
  const found: string[] = [];
  const scan = (item: unknown): void => {
    if (typeof item === "string") {
      RESULT_REFERENCE_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = RESULT_REFERENCE_PATTERN.exec(item)) !== null) {
        found.push(match[0]);
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        scan(child);
      }
      return;
    }
    if (isRecord(item)) {
      for (const child of Object.values(item)) {
        scan(child);
      }
    }
  };
  scan(value);
  return Array.from(new Set(found));
}

export function collectResultReferenceIndexes(value: unknown): number[] {
  const found = new Set<number>();
  const scan = (item: unknown): void => {
    if (typeof item === "string") {
      RESULT_REFERENCE_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = RESULT_REFERENCE_PATTERN.exec(item)) !== null) {
        const index = Number.parseInt(match[1] ?? "", 10);
        if (Number.isInteger(index)) {
          found.add(index);
        }
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        scan(child);
      }
      return;
    }
    if (isRecord(item)) {
      for (const child of Object.values(item)) {
        scan(child);
      }
    }
  };
  scan(value);
  return [...found];
}

export function buildToolReferenceErrorResult(
  toolName: string,
  placeholders: string[],
): ToolExecutionResult<string> {
  const summary = `参数中包含未替换的占位符: ${placeholders.join(", ")}，请检查引用路径是否正确`;
  return {
    success: false,
    tool_name: toolName,
    summary,
    answer: null,
    output_type: "error",
    content: summary,
    metadata: {
      source_shape: "error",
      unresolved_placeholders: placeholders,
    },
    artifacts: [],
    llm_hint: null,
  };
}

export function buildToolExecutionErrorResult(toolName: string, error: unknown): ToolExecutionResult<string> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    tool_name: toolName,
    summary: message,
    answer: null,
    output_type: "error",
    content: message,
    metadata: {
      source_shape: "error",
    },
    artifacts: [],
    llm_hint: null,
  };
}

function stringifyJsonPretty(value: unknown): string {
  const rendered = JSON.stringify(value, null, 2);
  return rendered === undefined ? String(value) : rendered;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
