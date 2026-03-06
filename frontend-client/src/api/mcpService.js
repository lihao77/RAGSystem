/**
 * MCP (Model Context Protocol) 管理 API
 */

const API_BASE = '/api/mcp';

async function parseResponse(response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.message || `Request failed: ${response.status}`);
  }
  return result;
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  return parseResponse(response);
}

export async function listMCPServers() {
  return request('/servers');
}

export async function listMCPTemplates() {
  return request('/templates');
}

export async function installMCPServerFromTemplate(payload) {
  return request('/templates/install', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function listMCPRegistryServers(params = {}) {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  query.set('latest_only', params.latest_only === false ? 'false' : 'true');
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request(`/registry/servers${suffix}`);
}

export async function installMCPRegistryServer(payload) {
  return request('/registry/install', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateMCPServer(serverName, payload) {
  return request(`/servers/${encodeURIComponent(serverName)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function deleteMCPServer(serverName) {
  return request(`/servers/${encodeURIComponent(serverName)}`, {
    method: 'DELETE',
  });
}

export async function connectMCPServer(serverName) {
  return request(`/servers/${encodeURIComponent(serverName)}/connect`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function disconnectMCPServer(serverName) {
  return request(`/servers/${encodeURIComponent(serverName)}/disconnect`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function testMCPServer(serverName) {
  return request(`/servers/${encodeURIComponent(serverName)}/test`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function getMCPServerTools(serverName) {
  return request(`/servers/${encodeURIComponent(serverName)}/tools`);
}

export default {
  listMCPServers,
  listMCPTemplates,
  installMCPServerFromTemplate,
  listMCPRegistryServers,
  installMCPRegistryServer,
  updateMCPServer,
  deleteMCPServer,
  connectMCPServer,
  disconnectMCPServer,
  testMCPServer,
  getMCPServerTools,
};
