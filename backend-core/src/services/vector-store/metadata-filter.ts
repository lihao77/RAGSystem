/** Mirrors PostgreSQL jsonb containment for the subset used by knowledge search filters. */
export function metadataMatchesFilter(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  return jsonContains(metadata, filter);
}

function jsonContains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((expectedItem) => actual.some((actualItem) => jsonContains(actualItem, expectedItem)));
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.entries(expected).every(([key, value]) => key in actual && jsonContains(actual[key], value));
  }
  return Object.is(actual, expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
