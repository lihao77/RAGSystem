import path from "node:path";

export function parseJsonObject(rawValue: string | null | undefined): Record<string, unknown> {
  if (!rawValue) {
    return {};
  }
  const parsed = JSON.parse(rawValue) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Convert SQLite's UTC `CURRENT_TIMESTAMP` text into the API timestamp format. */
export function sqliteTimestampToIso(value: string): string {
  const timestamp = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    ? value
    : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid SQLite timestamp: ${value}`);
  }
  return parsed.toISOString();
}

/** 把 RFC3339 游标或 SQLite 行文本统一收敛回内部比较用的 SQLite 时间戳文本（对两种输入形状幂等）。 */
export function isoTimestampToSqlite(value: string): string {
  // 先经 sqliteTimestampToIso 归一：直接 new Date("YYYY-MM-DD HH:MM:SS") 会按本地时区解析，UTC+8 机器上偏 8 小时。
  const iso = sqliteTimestampToIso(value);
  const seconds = iso.slice(0, 19).replace("T", " ");
  return iso.endsWith(".000Z") ? seconds : `${seconds}${iso.slice(19, 23)}`;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
