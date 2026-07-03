import { http } from './http.js';

const API_BASE = '/api/permissions';

export function getPermissionPolicy() {
  return http.get(`${API_BASE}/policy`);
}

export function updatePermissionMode(mode) {
  return http.put(`${API_BASE}/mode`, { mode });
}

export function updatePermissionPolicy(policy) {
  return http.put(`${API_BASE}/policy`, policy);
}

export function addAutoAcceptPattern(patternType, patternValue, description = '') {
  return http.post(`${API_BASE}/auto-accept`, {
    pattern_type: patternType,
    pattern_value: patternValue,
    description,
  });
}

export function removeAutoAcceptPattern(patternType, patternValue) {
  return http.request(`${API_BASE}/auto-accept`, {
    method: 'DELETE',
    body: {
      pattern_type: patternType,
      pattern_value: patternValue,
    },
  });
}

export function clearAutoAcceptPatterns() {
  return http.del(`${API_BASE}/auto-accept/all`);
}
