/**
 * 文件管理 API
 */

import { get, postFormData, del } from './http.js';

export async function listFiles() {
  return await get('/api/files');
}

export async function uploadFiles(fileList) {
  const form = new FormData();
  for (const f of fileList) form.append('files', f);
  return await postFormData('/api/files/upload', form);
}

export async function deleteFile(id) {
  return await del(`/api/files/${id}`);
}

export function downloadUrl(id) {
  return `http://localhost:5000/api/files/${id}/download`;
}

export default { listFiles, uploadFiles, deleteFile, downloadUrl };
