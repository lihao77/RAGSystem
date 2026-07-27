const POSTGRES_NUL = /\u0000/g;

/** PostgreSQL text values cannot contain the zero byte. */
export function sanitizePostgresText(value: string): string {
  return value.replace(POSTGRES_NUL, "");
}

/**
 * Prepare query parameters at the PostgreSQL boundary.
 *
 * Plain text parameters lose only real NUL characters. JSON parameters are
 * parsed and sanitized structurally because PostgreSQL JSON/JSONB also rejects
 * JSON's `\u0000` escape after decoding it. A literal `\\u0000` string remains
 * untouched.
 */
export function sanitizePostgresParams(
  sql: string,
  params: readonly unknown[],
): unknown[] {
  const jsonIndexes = jsonParameterIndexes(sql);
  return params.map((value, index) => jsonIndexes.has(index)
    ? sanitizeJsonParameter(value)
    : sanitizeTextParameter(value));
}

function sanitizeTextParameter(value: unknown): unknown {
  if (typeof value === "string") return sanitizePostgresText(value);
  if (Array.isArray(value)) return value.map(sanitizeTextParameter);
  return value;
}

function sanitizeJsonParameter(value: unknown): unknown {
  if (value == null) return value;
  const serialized = typeof value === "string"
    ? sanitizePostgresText(value)
    : JSON.stringify(value);
  if (serialized === undefined) return value;
  try {
    return JSON.stringify(sanitizeJsonValue(JSON.parse(serialized)));
  } catch {
    // Preserve PostgreSQL's normal invalid-JSON error while still ensuring an
    // actual zero byte never reaches the wire protocol.
    return sanitizePostgresText(serialized);
  }
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizePostgresText(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      sanitizePostgresText(key),
      sanitizeJsonValue(item),
    ]));
  }
  return value;
}

function jsonParameterIndexes(sql: string): Set<number> {
  const indexes = new Set<number>();
  for (const pattern of [
    /\$(\d+)\s*::\s*jsonb?\b/giu,
    /cast\s*\(\s*\$(\d+)\s+as\s+jsonb?\s*\)/giu,
  ]) {
    for (const match of sql.matchAll(pattern)) {
      const parameterNumber = Number(match[1]);
      if (Number.isSafeInteger(parameterNumber) && parameterNumber > 0) {
        indexes.add(parameterNumber - 1);
      }
    }
  }
  return indexes;
}
