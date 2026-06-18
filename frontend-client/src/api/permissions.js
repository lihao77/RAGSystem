const API_BASE = '/api/permissions';

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  // 仅在请求携带 body 时声明 JSON content-type;无 body 的请求(如清空自动接受规则)
  // 若声明 application/json,TS 后端 Fastify 会以 FST_ERR_CTP_EMPTY_JSON_BODY 拒绝。
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  if (options.body !== undefined && !hasContentType) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
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
