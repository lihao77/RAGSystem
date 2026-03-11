/**
 * 向量库管理 API
 * 封装文件管理、向量索引、向量化器和向量搜索相关接口
 */

async function parseResponse(response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.detail || result.message || `请求失败: ${response.status}`);
  }
  return result;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  return parseResponse(response);
}

// ── 文件管理 ────────────────────────────────────────────────────────────────

/**
 * 列出已上传的文件
 * @param {string[]} [extensions] - 文件扩展名过滤
 * @param {string[]} [mimeTypes] - MIME 类型过滤
 */
export async function listFiles(extensions, mimeTypes) {
  const query = new URLSearchParams();
  if (extensions?.length) query.set('extensions', extensions.join(','));
  if (mimeTypes?.length) query.set('mime_types', mimeTypes.join(','));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request(`/api/files${suffix}`);
}

/**
 * 上传文件（支持多文件）
 * @param {FormData} formData - 包含 files 字段的表单数据
 */
export async function uploadFiles(formData) {
  const response = await fetch('/api/files/upload', {
    method: 'POST',
    body: formData,
    // 不设置 Content-Type，让浏览器自动设置 multipart/form-data
  });
  return parseResponse(response);
}

/**
 * 删除文件
 * @param {string} fileId - 文件 ID
 */
export async function deleteFile(fileId) {
  return request(`/api/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
  });
}

// ── 向量索引管理 ─────────────────────────────────────────────────────────────

/**
 * 获取文件的向量索引状态
 */
export async function getFileStatus() {
  return request('/api/vector-library/file-status');
}

/**
 * 将文件加入向量索引
 * @param {Object} body - { file_id, vectorizer_key?, collection? }
 */
export async function indexFile(body) {
  return request('/api/vector-library/index-file', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * 删除文件的向量索引
 * @param {Object} body - { file_id, collection? }
 */
export async function deleteFileIndex(body) {
  return request('/api/vector-library/delete-file', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ── 向量化器管理 ─────────────────────────────────────────────────────────────

/**
 * 列出所有向量化器
 */
export async function listVectorizers() {
  return request('/api/vector-library/vectorizers');
}

/**
 * 添加向量化器
 * @param {Object} body - { key, model, ... }
 */
export async function addVectorizer(body) {
  return request('/api/vector-library/vectorizers', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * 激活指定向量化器
 * @param {string} key - 向量化器 key
 */
export async function activateVectorizer(key) {
  return request(`/api/vector-library/vectorizers/${encodeURIComponent(key)}/activate`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * 删除向量化器
 * @param {string} key - 向量化器 key
 */
export async function deleteVectorizer(key) {
  return request(`/api/vector-library/vectorizers/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
}

/**
 * 将上传文件首次导入向量集合
 * @param {Object} body - { file_id, document_id?, collection_name?, metadata?, chunk_size?, overlap? }
 */
export async function ingestFileToCollection(body) {
  return request('/api/vector/index', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ── 向量搜索 ─────────────────────────────────────────────────────────────────

/**
 * 向量相似度搜索
 * @param {Object} body - { query, top_k?, collection?, vectorizer_key? }
 */
export async function searchVectors(body) {
  return request('/api/vector/search', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * 获取向量库健康状态
 */
export async function getVectorHealth() {
  return request('/api/vector/health');
}

/**
 * 列出某向量化器下的文档
 * @param {string} key - 向量化器 key
 * @param {Object} [params] - 查询参数
 */
export async function listDocsByVectorizer(key, params = {}) {
  const q = new URLSearchParams(params).toString();
  const suffix = q ? `?${q}` : '';
  return request(`/api/vector-library/vectorizers/${encodeURIComponent(key)}/docs${suffix}`);
}

/**
 * 在向量化器之间迁移数据
 * @param {Object} body - { from_key, to_key, collection? }
 */
export async function migrateVectorizer(body) {
  return request('/api/vector-library/migrate', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export default {
  listFiles,
  uploadFiles,
  deleteFile,
  getFileStatus,
  indexFile,
  deleteFileIndex,
  listVectorizers,
  addVectorizer,
  activateVectorizer,
  deleteVectorizer,
  listDocsByVectorizer,
  migrateVectorizer,
  ingestFileToCollection,
  searchVectors,
  getVectorHealth,
};
