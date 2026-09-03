import { http } from './http.js';

export function workspaceFileUrl(sessionId, filePath) {
  const session = String(sessionId || '').trim();
  const path = String(filePath || '').trim();
  if (!session || !path) return '';
  return `/api/agent/sessions/${encodeURIComponent(session)}/workspace-files/content?path=${encodeURIComponent(path)}`;
}

/**
 * 拉取工作区文件内容。携带 ifNoneMatch 时服务端内容未变返回 304（无 body），
 * 由调用方按 response.status 分支；304 视为成功不抛错。
 */
export function getWorkspaceFileContent(sessionId, filePath, options = {}) {
  const url = workspaceFileUrl(sessionId, filePath);
  if (!url) throw new Error('session_id 和 file_path 必填');
  return http.getRaw(url, {
    responseType: 'blob',
    signal: options.signal,
    headers: options.ifNoneMatch ? { 'If-None-Match': options.ifNoneMatch } : undefined,
    validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
  });
}
