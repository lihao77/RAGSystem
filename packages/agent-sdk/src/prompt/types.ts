/** prompt 上下文类型（设计稿 §7，删 skill/delegation——profile 不含这些衍生字段）。 */
import type { RuntimeToolDefinition } from "./tool-types.js";

export interface AgentPromptContext {
  tools?: RuntimeToolDefinition[];
}

export function collectSections(parts: Array<string | null | undefined>): string[] {
  return parts.map((part) => part?.trim() ?? "").filter(Boolean);
}

export function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
