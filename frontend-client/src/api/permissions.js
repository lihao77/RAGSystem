const API_BASE = '/api/permissions';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) throw new Error(`Permission API error: ${response.status}`);
  return response.json();
}

export function getPermissionPolicy() {
  return request('/policy');
}

export function updatePermissionMode(mode) {
  return request('/mode', {
    method: 'PUT',
    body: JSON.stringify({ mode }),
  });
}

export function updatePermissionPolicy(policy) {
  return request('/policy', {
    method: 'PUT',
    body: JSON.stringify(policy),
  });
}

export function addAutoAcceptPattern(patternType, patternValue, description = '') {
  return request('/auto-accept', {
    method: 'POST',
    body: JSON.stringify({ pattern_type: patternType, pattern_value: patternValue, description }),
  });
}

export function removeAutoAcceptPattern(patternType, patternValue) {
  return request('/auto-accept', {
    method: 'DELETE',
    body: JSON.stringify({ pattern_type: patternType, pattern_value: patternValue }),
  });
}

export function clearAutoAcceptPatterns() {
  return request('/auto-accept/all', { method: 'DELETE' });
}
