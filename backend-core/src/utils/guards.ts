/** 是否为普通对象（非 null、非数组）。路由/服务层广泛复用的类型守卫，统一在此一处。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function asString(value: unknown): string | null {
  return normalizeString(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
