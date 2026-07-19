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

export function stringifyJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
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
