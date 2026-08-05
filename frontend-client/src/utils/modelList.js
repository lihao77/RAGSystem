export function normalizeModelList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  const model = String(value || '').trim();
  return model ? [model] : [];
}

/**
 * Return the models configured for a provider, keeping chat first and removing duplicates.
 * Model providers may expose task-specific entries in model_map or legacy models/model fields.
 */
export function getProviderModels(provider) {
  if (!provider) return [];

  const models = [];
  const seen = new Set();
  const addModels = (value) => {
    for (const model of normalizeModelList(value)) {
      if (!seen.has(model)) {
        models.push(model);
        seen.add(model);
      }
    }
  };

  if (provider.model_map && typeof provider.model_map === 'object') {
    addModels(provider.model_map.chat);
    Object.entries(provider.model_map).forEach(([task, value]) => {
      if (task !== 'chat') addModels(value);
    });
  }
  addModels(provider.models);
  addModels(provider.model);
  return models;
}

export function applyProviderToLlm(llm, provider) {
  const next = {
    ...llm,
    provider: provider.name || provider.key || '',
    provider_type: provider.provider_type || '',
    model_name: getProviderModels(provider)[0] || '',
  };
  if (provider.temperature != null) next.temperature = Number(provider.temperature);
  if (provider.max_completion_tokens != null) next.max_completion_tokens = Number(provider.max_completion_tokens);
  if (provider.max_context_tokens != null) next.max_context_tokens = Number(provider.max_context_tokens);
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
