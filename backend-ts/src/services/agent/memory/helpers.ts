/**
 * memory-prefix 辅助纯函数（随 memory 模块从 SDK 内核迁回 backend）。
 * scope 判断、heading 常量、指纹 stringify、字符串数组/记录归一——memory 业务专用。
 */
import type { MemoryScopeName } from "../../../contracts/memory-store/index.js";

/** memory 前缀块标记串。 */
export const MEMORY_SCOPE_CAPABILITIES_HEADING = "[Memory Scope Capabilities]";
export const MEMORY_INDEX_HEADING_SUFFIX = "Memory Index]";

export function isMemoryScopeName(value: unknown): value is MemoryScopeName {
  return value === "team" || value === "session" || value === "agent" || value === "workspace" || value === "user";
}

export function pythonStableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonStableJsonStringify(item)).join(", ")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}: ${pythonStableJsonStringify(value[key])}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

export function titleCase(value: string): string {
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : value;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) { return {}; }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") { output[key] = item; }
  }
  return output;
}

export function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
