export function normalizeModelList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  const model = String(value || '').trim();
  return model ? [model] : [];
}

/**
 * Provider 模型目录（模型条目对象数组）→ 模型名列表；保持配置顺序（首个即默认模型）。
 */
export function getProviderModels(provider) {
  if (!provider || !Array.isArray(provider.models)) return [];
  const models = [];
  const seen = new Set();
  for (const entry of provider.models) {
    const name = String(entry?.name || '').trim();
    if (name && !seen.has(name)) {
      models.push(name);
      seen.add(name);
    }
  }
  return models;
}

/** 按名称取 provider 的模型条目（含模型级运行参数与能力位）；找不到返回 null。 */
export function getProviderModelEntry(provider, modelName) {
  if (!provider || !Array.isArray(provider.models)) return null;
  const target = String(modelName || '').trim();
  if (!target) return null;
  return provider.models.find((entry) => String(entry?.name || '').trim() === target) || null;
}

/**
 * 切换 provider 时回填 agent tier：选该 provider 的首个模型，并镜像模型条目的运行参数。
 */
export function applyProviderToLlm(llm, provider) {
  const entry = Array.isArray(provider?.models)
    ? provider.models.find((item) => String(item?.name || '').trim())
    : null;
  const next = {
    ...llm,
    provider: provider?.name || provider?.key || '',
    provider_type: provider?.provider_type || '',
    model_name: entry ? String(entry.name).trim() : '',
  };
  if (entry?.temperature != null) next.temperature = Number(entry.temperature);
  if (entry?.max_completion_tokens != null) next.max_completion_tokens = Number(entry.max_completion_tokens);
  if (entry?.max_context_tokens != null) next.max_context_tokens = Number(entry.max_context_tokens);
  return next;
}

export function createExtraParamEntry(key = '', type = 'string', value = '') {
  return { key, type, value };
}

export function parseExtraParamEntries(extraParams) {
  if (!extraParams || typeof extraParams !== 'object' || Array.isArray(extraParams)) return [];
  return Object.entries(extraParams).map(([key, value]) => {
    if (typeof value === 'number') return createExtraParamEntry(key, 'number', String(value));
    if (typeof value === 'boolean') return createExtraParamEntry(key, 'boolean', value ? 'true' : 'false');
    if (value && typeof value === 'object') {
      try { return createExtraParamEntry(key, 'json', JSON.stringify(value)); } catch { return createExtraParamEntry(key, 'json', '{}'); }
    }
    return createExtraParamEntry(key, 'string', value == null ? '' : String(value));
  });
}

export function parseExtraParamsInput(entries, scopeLabel = 'LLM ') {
  const result = {};
  for (const entry of entries || []) {
    const key = String(entry?.key || '').trim();
    if (!key) continue;
    const type = entry?.type || 'string';
    const rawValue = entry?.value ?? '';
    if (type === 'string') { result[key] = String(rawValue); continue; }
    if (type === 'number') {
      const parsed = Number(rawValue);
      if (rawValue === '' || Number.isNaN(parsed)) throw new Error(`${scopeLabel}参数 ${key} 的 value 必须是数字`);
      result[key] = parsed;
      continue;
    }
    if (type === 'boolean') {
      const normalized = String(rawValue).trim().toLowerCase();
      if (normalized === 'true' || normalized === 'false') { result[key] = normalized === 'true'; continue; }
      throw new Error(`${scopeLabel}参数 ${key} 的 value 必须是 true 或 false`);
    }
    if (type === 'json') {
      try { result[key] = JSON.parse(String(rawValue || '{}')); } catch { throw new Error(`${scopeLabel}参数 ${key} 的 value 必须是合法 JSON`); }
      continue;
    }
    throw new Error(`${scopeLabel}参数 ${key} 的 type 无效`);
  }
  return result;
}
