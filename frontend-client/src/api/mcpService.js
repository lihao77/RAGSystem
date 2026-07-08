/**
 * MCP (Model Context Protocol) 管理 API
 */

import { http } from './http.js';

const API_BASE = '/api/mcp';

export async function listMCPServers() {
  return http.get(`${API_BASE}/servers`);
}

export async function addMCPServer(payload) {
  return http.post(`${API_BASE}/servers`, payload);
}

export async function listMCPRegistryServers(params = {}) {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  query.set('latest_only', params.latest_only === false ? 'false' : 'true');
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return http.get(`${API_BASE}/registry/servers${suffix}`);
}

export async function installMCPRegistryServer(payload) {
  return http.post(`${API_BASE}/registry/install`, payload);
}

export async function updateMCPServer(serverName, payload) {
  return http.put(`${API_BASE}/servers/${encodeURIComponent(serverName)}`, payload);
}

export async function deleteMCPServer(serverName) {
  return http.del(`${API_BASE}/servers/${encodeURIComponent(serverName)}`);
}

export async function connectMCPServer(serverName) {
  return http.post(`${API_BASE}/servers/${encodeURIComponent(serverName)}/connect`, {});
}

export async function disconnectMCPServer(serverName) {
  return http.post(`${API_BASE}/servers/${encodeURIComponent(serverName)}/disconnect`, {});
}

export async function testMCPServer(serverName) {
  return http.post(`${API_BASE}/servers/${encodeURIComponent(serverName)}/test`, {});
}

export async function getMCPServerTools(serverName) {
  return http.get(`${API_BASE}/servers/${encodeURIComponent(serverName)}/tools`);
}

export async function listMCPServerResources(serverName) {
  return http.get(`${API_BASE}/servers/${encodeURIComponent(serverName)}/resources`);
}

export async function readMCPServerResource(serverName, uri) {
  return http.post(`${API_BASE}/servers/${encodeURIComponent(serverName)}/resources/read`, { uri });
}

export async function listMCPServerPrompts(serverName) {
  return http.get(`${API_BASE}/servers/${encodeURIComponent(serverName)}/prompts`);
}

export async function getMCPServerPrompt(serverName, name, args) {
  return http.post(`${API_BASE}/servers/${encodeURIComponent(serverName)}/prompts/get`, { name, ...(args ? { arguments: args } : {}) });
}

export async function listAllMCPPrompts() {
  return http.get(`${API_BASE}/prompts`);
}

export async function getMCPServerMetrics(serverName) {
  return http.get(`${API_BASE}/servers/${encodeURIComponent(serverName)}/metrics`);
}

export default {
  listMCPServers,
  addMCPServer,
  listMCPRegistryServers,
  installMCPRegistryServer,
  updateMCPServer,
  deleteMCPServer,
  connectMCPServer,
  disconnectMCPServer,
  testMCPServer,
  getMCPServerTools,
  listMCPServerResources,
  readMCPServerResource,
  listMCPServerPrompts,
  getMCPServerPrompt,
  listAllMCPPrompts,
  getMCPServerMetrics,
};
