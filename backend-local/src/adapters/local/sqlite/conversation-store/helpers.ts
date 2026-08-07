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

/** Convert an RFC3339 UTC cursor back to SQLite's indexed timestamp text format. */
export function isoTimestampToSqlite(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid RFC3339 timestamp: ${value}`);
  }
  const iso = parsed.toISOString();
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
