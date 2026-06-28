/**
 * context-builder 辅助函数。
 * 仅保留 recent source / history-view / context-builder 用的通用工具；memory 专用
 * （scope 判断、heading 常量、指纹 stringify、字符串数组/记录归一）随 memory 模块迁出 SDK。
 */
import type { SessionMetadataPort } from "./types.js";
import { DEFAULT_MICROCOMPACT_TTL_SECONDS } from "./types.js";

export function readPipelineCache(sessionMetadata: Record<string, unknown>, threadKey: string): Record<string, unknown> {
  const caches = asRecord(sessionMetadata._pipeline_caches);
  return asRecord(caches?.[threadKey]) ?? {};
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
