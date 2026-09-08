/**
 * Provider 自定义请求头（headers）：后端 Record<string, string> ↔ 表单行编辑互转。
 * 会话占位符 {session_id} 原样透传——调用期由 agent-llm 解析为会话稳定路由键
 * （网关路由/缓存亲和，如 opencode Console Go 的 x-opencode-session、sub2api 的 session_id）。
 */

/** 后端对象 → 表单行（顺序保留）；非对象（null/undefined/畸形）按无头处理。 */
export function headerRowsFromObject(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value ?? '') }));
}

/** 表单行 → 后端对象：名称 trim 非空才收、值原样；无有效行返回 undefined（payload 剥键 = 清空）。 */
export function headerObjectFromRows(rows) {
  const headers = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String(row?.name ?? '').trim();
    if (!name) continue;
    headers[name] = String(row?.value ?? '');
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
