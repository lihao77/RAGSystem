/**
 * Record 合并工具。
 *
 * 合并若干 extra_params 来源（后者覆盖前者同名 key），过滤 null/undefined。
 * 客户端构造请求 body 时用：协议层显式字段（model/messages/temperature/...）后置 spread，
 * 永不被 extra 覆盖。
 */
export function compactRecord(...sources: ReadonlyArray<unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    if (!isRecordLike(source)) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      if (value !== null && value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
