/**
 * 知识库管理 API
 * 封装文件管理、向量索引、向量化器和向量搜索相关接口
 */

import { http } from './http.js';

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
  return http.get(`/api/knowledge-bases/files${suffix}`);
}

/**
 * 上传文件（支持多文件）
 * @param {FormData} formData - 包含 files 字段的表单数据
 */
export async function uploadFiles(formData) {
  return http.post('/api/knowledge-bases/files/upload', formData);
}

/**
 * 删除文件
 * @param {string} fileId - 文件 ID
 */
export async function deleteFile(fileId) {
  return http.del(`/api/knowledge-bases/files/${encodeURIComponent(fileId)}`);
}

export async function getFileMd(fileId) {
  return http.get(`/api/knowledge-bases/files/${encodeURIComponent(fileId)}/md`);
}

export async function updateFileMd(fileId, content) {
  return http.put(`/api/knowledge-bases/files/${encodeURIComponent(fileId)}/md`, { content });
}

export async function getFileChunks(fileId) {
  return http.get(`/api/knowledge-bases/files/${encodeURIComponent(fileId)}/chunks`);
}

export async function updateFileChunk(fileId, chunkId, content) {
  return http.patch(`/api/knowledge-bases/files/${encodeURIComponent(fileId)}/chunks/${encodeURIComponent(chunkId)}`, { content });
}

// ── 向量索引管理 ─────────────────────────────────────────────────────────────

/**
 * 获取文件的向量索引状态
 */
export async function getFileStatus() {
  return http.get('/api/knowledge-bases/file-status');
}

/**
 * 将文件加入向量索引
 * @param {Object} body - { file_id, vectorizer_key?, collection? }
 */
export async function indexFile(body) {
  return http.post('/api/knowledge-bases/index-file', body);
}

// ── 向量化器管理 ─────────────────────────────────────────────────────────────

/**
 * 列出所有向量化器
 */
export async function listVectorizers() {
  return http.get('/api/knowledge-bases/vectorizers');
}

/**
 * 添加向量化器
 * @param {Object} body - { key, model, ... }
 */
export async function addVectorizer(body) {
  return http.post('/api/knowledge-bases/vectorizers', body);
}

/**
 * 激活指定向量化器
 * @param {string} key - 向量化器 key
 */
export async function activateVectorizer(key) {
  return http.post(`/api/knowledge-bases/vectorizers/${encodeURIComponent(key)}/activate`, {});
}

/**
 * 删除向量化器
 * @param {string} key - 向量化器 key
 */
export async function deleteVectorizer(key) {
  return http.del(`/api/knowledge-bases/vectorizers/${encodeURIComponent(key)}`);
}

/**
 * 将上传文件首次导入向量集合
 * @param {Object} body - { file_id, document_id?, collection_name?, metadata?, chunk_size?, overlap? }
 */
export async function ingestFileToCollection(body) {
  return http.post('/api/knowledge-bases/index', body);
}

// ── 重排序器管理 ─────────────────────────────────────────────────────────────

/**
 * 列出所有重排序器
 */
export async function listRerankers() {
  return http.get('/api/knowledge-bases/rerankers');
}

/**
 * 添加重排序器
 * @param {Object} body - { mode, provider_key? }; model 模式只引用已配置 Rerank 能力的 Model Provider
 */
export async function addReranker(body) {
  return http.post('/api/knowledge-bases/rerankers', body);
}

/**
 * 获取重排序器配置
 * @param {string} key - 重排序器 key
 */
export async function getReranker(key) {
  return http.get(`/api/knowledge-bases/rerankers/${encodeURIComponent(key)}`);
}

/**
 * 激活指定重排序器
 * @param {string} key - 重排序器 key
 */
export async function activateReranker(key) {
  return http.post(`/api/knowledge-bases/rerankers/${encodeURIComponent(key)}/activate`, {});
}

/**
 * 删除重排序器
 * @param {string} key - 重排序器 key
 */
export async function deleteReranker(key) {
  return http.del(`/api/knowledge-bases/rerankers/${encodeURIComponent(key)}`);
}

// ── 向量搜索 ─────────────────────────────────────────────────────────────────

/**
 * 向量相似度搜索
 * @param {Object} body - { query, top_k?, collection?, search_mode?, filters?, rerank?, rerank_mode?, rerank_top_k?, rerank_provider?, rerank_model? }
 */
export async function searchVectors(body) {
  return http.post('/api/knowledge-bases/search', body);
}

/**
 * 获取知识库健康状态
 */
export async function getVectorHealth() {
  return http.get('/api/knowledge-bases/health');
}

/**
 * 列出某向量化器下的文档
 * @param {string} key - 向量化器 key
 * @param {Object} [params] - 查询参数
 */
export async function listDocsByVectorizer(key, params = {}) {
  const q = new URLSearchParams(params).toString();
  const suffix = q ? `?${q}` : '';
  return http.get(`/api/knowledge-bases/vectorizers/${encodeURIComponent(key)}/docs${suffix}`);
}

/**
 * 在向量化器之间迁移数据
 * @param {Object} body - { from_key, to_key, collection? }
 */
export async function migrateVectorizer(body) {
  return http.post('/api/knowledge-bases/migrate', body);
}

export default {
  listFiles,
  uploadFiles,
  deleteFile,
  getFileStatus,
  indexFile,
  listVectorizers,
  addVectorizer,
  activateVectorizer,
  deleteVectorizer,
  listDocsByVectorizer,
  migrateVectorizer,
  listRerankers,
  addReranker,
  getReranker,
  activateReranker,
  deleteReranker,
  ingestFileToCollection,
  searchVectors,
  getVectorHealth,
};
