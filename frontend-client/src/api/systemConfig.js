/**
 * 系统配置 API 模块
 */

const API_BASE = '/api/system-config';

export async function getSystemConfigSchema() {
  const response = await fetch(`${API_BASE}/schema`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || '获取配置 schema 失败');
  return result.data;
}

export async function getSystemConfig() {
  const response = await fetch(`${API_BASE}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || '获取系统配置失败');
  return result.data;
}

export async function updateSystemConfig(data) {
  const response = await fetch(`${API_BASE}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || '更新系统配置失败');
  return result.data;
}

export async function reloadSystemConfig() {
  const response = await fetch(`${API_BASE}/reload`, { method: 'POST' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || '重新加载配置失败');
  return result;
}
