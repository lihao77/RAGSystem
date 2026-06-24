/**
 * context-builder 辅助函数（迁自 backend-ts context-builder/helpers.ts）。
 * 删 systemConfig 相关（TTL 改构造期注入）+ memory-store 类型依赖（memory 模块落地时补）。
 */
import type { SessionMetadataPort } from "./types.js";
import { DEFAULT_MICROCOMPACT_TTL_SECONDS } from "./types.js";

/** memory 前缀块标记串——单一信源（memory 模块与 context 共用）。 */
export const MEMORY_SCOPE_CAPABILITIES_HEADING = "[Memory Scope Capabilities]";
export const MEMORY_INDEX_HEADING_SUFFIX = "Memory Index]";

export function isStableSystemContextContent(content: string): boolean {
  return content.includes(MEMORY_SCOPE_CAPABILITIES_HEADING) || content.includes(MEMORY_INDEX_HEADING_SUFFIX);
}

export function readPipelineCache(sessionMetadata: Record<string, unknown>, threadKey: string): Record<string, unknown> {
  const caches = asRecord(sessionMetadata._pipeline_caches);
  return asRecord(caches?.[threadKey]) ?? {};
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function isSessionMetadataPort(value: unknown): value is SessionMetadataPort {
  return Boolean(value && typeof value === "object" && "getSession" in value && typeof value.getSession === "function");
}

export function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function positiveIntegerOrDefault(value: unknown, defaultValue: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : defaultValue;
}

export function positiveNumberOrDefault(value: unknown, defaultValue: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : defaultValue;
}

export function resolveMicrocompactTtlSeconds(injected: number | undefined): number {
  return positiveNumberOrDefault(injected, DEFAULT_MICROCOMPACT_TTL_SECONDS);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
