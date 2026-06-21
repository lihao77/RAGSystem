/** 是否为普通对象（非 null、非数组）。路由/服务层广泛复用的类型守卫，统一在此一处。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
