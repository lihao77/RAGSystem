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

/** 项目（workspace）级目录列表：path 缺省为项目根目录。 */
export function workspaceEntryListUrl(workspaceId, directoryPath) {
  const workspace = String(workspaceId || '').trim();
  if (!workspace) return '';
  const query = directoryPath ? `?path=${encodeURIComponent(directoryPath)}` : '';
  return `/api/agent/workspaces/${encodeURIComponent(workspace)}/files${query}`;
}

export function workspaceEntryContentUrl(workspaceId, filePath) {
  const workspace = String(workspaceId || '').trim();
  const path = String(filePath || '').trim();
  if (!workspace || !path) return '';
  return `/api/agent/workspaces/${encodeURIComponent(workspace)}/files/content?path=${encodeURIComponent(path)}`;
}

/** 列出项目某层目录的条目（目录在前），服务端超过上限会置 truncated。 */
export async function listWorkspaceEntries(workspaceId, directoryPath) {
  const url = workspaceEntryListUrl(workspaceId, directoryPath);
  if (!url) throw new Error('workspace_id 必填');
  const response = await http.get(url);
  return response.data ?? { entries: [], truncated: false };
}

/** 拉取项目文件内容，缓存语义与 getWorkspaceFileContent 一致（304 视为成功不抛错）。 */
export function getWorkspaceEntryContent(workspaceId, filePath, options = {}) {
  const url = workspaceEntryContentUrl(workspaceId, filePath);
  if (!url) throw new Error('workspace_id 和 file_path 必填');
  return http.getRaw(url, {
    responseType: 'blob',
    signal: options.signal,
    headers: options.ifNoneMatch ? { 'If-None-Match': options.ifNoneMatch } : undefined,
    validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
  });
}
