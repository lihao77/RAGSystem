/**
 * 系统配置 API 模块
 */

import { http } from './http.js';

const API_BASE = '/api/system-config';

export async function getSystemConfigSchema() {
  const result = await http.get(`${API_BASE}/schema`);
  return result.data;
}

export async function getSystemConfig() {
  const result = await http.get(`${API_BASE}`);
  return result.data;
}

export async function updateSystemConfig(data) {
  const result = await http.patch(`${API_BASE}`, data);
  return result.data;
}

export async function reloadSystemConfig() {
  return http.post(`${API_BASE}/reload`);
}
