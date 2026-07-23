function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function normalizeProviderTestResult(payload) {
  const root = asObject(payload) || {};
  const response = asObject(root.response) || asObject(root.data) || root;
  return {
    ...response,
    error: typeof response.error === 'string' && response.error.trim() ? response.error.trim() : null,
  };
}
