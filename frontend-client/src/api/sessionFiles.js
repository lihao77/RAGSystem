async function parseResponse(response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof result.detail === 'string'
      ? result.detail
      : Array.isArray(result.detail)
        ? result.detail.map(item => item?.msg || JSON.stringify(item)).join('; ')
        : result.message;
    throw new Error(detail || `请求失败: ${response.status}`);
  }
  return result;
}

export async function listSessionFiles(sessionId) {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/files`);
  return parseResponse(response);
}

export async function uploadSessionFiles(sessionId, formData) {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/files/upload`, {
    method: 'POST',
    body: formData,
  });
  return parseResponse(response);
}

export async function deleteSessionFile(sessionId, fileId) {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
  });
  return parseResponse(response);
}

export function getSessionFileDownloadUrl(sessionId, fileId) {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}/download`;
}

export async function validateSessionFiles(sessionId, fileIds) {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/files/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_ids: fileIds }),
  });
  return parseResponse(response);
}
