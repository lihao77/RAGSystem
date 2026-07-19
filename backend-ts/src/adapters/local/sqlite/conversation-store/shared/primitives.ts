import { isRecord } from "../../../../../utils/guards.js";
export { isRecord };
/** 会话存储通用纯函数（迁移自 conversation-store.ts 模块级 helper）。 */

export function numericCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeLimit(value: number | null | undefined, defaultValue: number, maxValue: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.min(maxValue, Math.max(1, Math.floor(value)));
}

export function normalizeOffset(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

export function uniquePositiveIntegers(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.floor(value)).filter((value) => Number.isSafeInteger(value) && value > 0))];
}

export function normalizeNonEmptyString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}



export function deepMergeRecords(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    const current = output[key];
    if (isRecord(current) && isRecord(value)) {
      output[key] = deepMergeRecords(current, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function ageSeconds(timestamp: string | null): number | null {
  if (!timestamp) {
    return null;
  }
  const parsed = Date.parse(timestamp.includes("T") ? timestamp : `${timestamp}Z`);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}
