export const MAX_PINNED_SESSIONS = 20;

/** Permanent normalization for local pin preferences, shared by reads and writes. */
export function normalizePinnedSessionIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
}
