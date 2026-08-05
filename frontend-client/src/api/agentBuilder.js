import { http } from './http.js';

const API_BASE = '/api/agent-builder';

export async function listAgentDrafts() {
  const result = await http.get(`${API_BASE}/drafts`);
  return result.data || [];
}

export async function getAgentDraft(id) {
  const result = await http.get(`${API_BASE}/drafts/${encodeURIComponent(id)}`);
  return result.data || result;
}

export async function createAgentDraft(blueprint) {
  const result = await http.post(`${API_BASE}/drafts`, { blueprint });
  return result.data || result;
}

export async function updateAgentDraft(id, expectedRevision, blueprint) {
  const result = await http.put(`${API_BASE}/drafts/${encodeURIComponent(id)}`, {
    expected_revision: expectedRevision,
    blueprint,
  });
  return result.data || result;
}

export async function deleteAgentDraft(id) {
  const result = await http.del(`${API_BASE}/drafts/${encodeURIComponent(id)}`);
  return result.data || result;
}

export async function validateAgentDraft(id) {
  const result = await http.post(`${API_BASE}/drafts/${encodeURIComponent(id)}/validate`);
  return result.data || result;
}

export async function publishAgentDraft(id, expectedRevision) {
  const result = await http.post(`${API_BASE}/drafts/${encodeURIComponent(id)}/publish`, {
    expected_revision: expectedRevision,
  });
  return result.data || result;
}

export async function listAgentReleases(packageName = '') {
  const query = packageName ? `?package_name=${encodeURIComponent(packageName)}` : '';
  const result = await http.get(`${API_BASE}/releases${query}`);
  return result.data || [];
}

export async function getAgentRelease(id) {
  const result = await http.get(`${API_BASE}/releases/${encodeURIComponent(id)}`);
  return result.data || result;
}
