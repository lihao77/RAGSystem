export function normalizeModelList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  const model = String(value || '').trim();
  return model ? [model] : [];
}
