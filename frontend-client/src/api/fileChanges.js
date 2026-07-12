import { http } from './http.js';

export async function getLatestFileChanges(sessionId) {
  return http.get(`/api/agent/sessions/${encodeURIComponent(sessionId)}/file-changes`);
}
