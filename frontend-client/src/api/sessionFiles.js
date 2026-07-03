import { http } from './http.js';

export async function listSessionFiles(sessionId) {
  return http.get(`/api/agent/sessions/${encodeURIComponent(sessionId)}/files`);
}

export async function uploadSessionFiles(sessionId, formData) {
  return http.post(`/api/agent/sessions/${encodeURIComponent(sessionId)}/files/upload`, formData);
}

export async function deleteSessionFile(sessionId, fileId) {
  return http.del(`/api/agent/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`);
}

export function getSessionFileDownloadUrl(sessionId, fileId) {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}/download`;
}

export async function validateSessionFiles(sessionId, fileIds) {
  return http.post(
    `/api/agent/sessions/${encodeURIComponent(sessionId)}/files/validate`,
    { file_ids: fileIds },
  );
}
