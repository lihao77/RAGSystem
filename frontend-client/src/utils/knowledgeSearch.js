export function parseKnowledgeSearchFilters(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('元数据过滤必须是有效的 JSON 对象');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('元数据过滤必须是 JSON 对象');
  }
  return parsed;
}

export function hasKnowledgeRetrievalSource(result, source) {
  return Array.isArray(result?.retrieval_sources) && result.retrieval_sources.includes(source);
}
