export function collectSections(parts: Array<string | null | undefined>): string[] {
  return parts.map((part) => part?.trim() ?? "").filter(Boolean);
}

export function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
