import { http } from './http.js';

const API_BASE = '/api/memory';

function compactParams(params = {}) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== '' && value !== null && value !== undefined),
  );
}

export function listMemoryEntries(params = {}) {
  return http.get(`${API_BASE}/entries`, { params: compactParams(params) });
}

export function listMyMemoryCandidates(params = {}) {
  return http.get(`${API_BASE}/candidates`, { params: compactParams(params) });
}

export function listAdminMemoryCandidates(params = {}) {
  return http.get(`${API_BASE}/admin/candidates`, { params: compactParams(params) });
}

export function archiveMemoryEntry(id, expectedVersion) {
  return http.post(`${API_BASE}/entries/${encodeURIComponent(id)}/archive`, {
    expected_version: expectedVersion,
  });
}

export function updateMemoryCandidate(id, payload) {
  return http.patch(`${API_BASE}/candidates/${encodeURIComponent(id)}`, payload);
}

export function withdrawMemoryCandidate(id, expectedVersion) {
  return http.del(`${API_BASE}/candidates/${encodeURIComponent(id)}`, {
    body: { expected_version: expectedVersion },
  });
}

export function approveMemoryCandidate(id, payload) {
  return http.post(`${API_BASE}/admin/candidates/${encodeURIComponent(id)}/approve`, payload);
}

export function rejectMemoryCandidate(id, payload) {
  return http.post(`${API_BASE}/admin/candidates/${encodeURIComponent(id)}/reject`, payload);
}
