import { http } from './http.js';

export function workspaceFileUrl(sessionId, filePath) {
  const session = String(sessionId || '').trim();
  const path = String(filePath || '').trim();
  if (!session || !path) return '';
  return `/api/agent/sessions/${encodeURIComponent(session)}/workspace-files/content?path=${encodeURIComponent(path)}`;
}

export function getWorkspaceFileContent(sessionId, filePath, options = {}) {
  const url = workspaceFileUrl(sessionId, filePath);
  if (!url) throw new Error('session_id 和 file_path 必填');
  return http.getRaw(url, {
    responseType: 'blob',
    signal: options.signal,
  });
}
