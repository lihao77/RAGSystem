/**
 * 向量库管理服务
 */

import { get, post, del } from './http';

/**
 * 获取所有向量集合列表
 */
export const getCollections = () => {
  return get('/api/vector/collections');
};

/**
 * 删除向量集合
 * @param {string} collectionName - 集合名称
 */
export const deleteCollection = (collectionName) => {
  return del(`/api/vector/collections/${collectionName}`);
};

/**
 * 向量检索
 * @param {string} collectionName - 集合名称
 * @param {string} query - 查询内容
 * @param {number} topK - 返回结果数量
 */
export const searchVectors = (collectionName, query, topK = 5) => {
  return post('/api/vector/search', {
    collection_name: collectionName,
    query,
    top_k: topK
  });
};

/**
 * 索引新文档
 * @param {Object} params - 索引参数
 * @param {string} params.collection_name - 集合名称
 * @param {string} params.document_id - 文档ID
 * @param {string} params.text - 文档内容
 * @param {Object} params.metadata - 文档元数据
 * @param {number} params.chunk_size - 分块大小
 * @param {number} params.overlap - 分块重叠
 */
export const indexDocument = (params) => {
  return post('/api/vector/index', params);
};

/**
 * 删除文档
 * @param {string} collectionName - 集合名称
 * @param {string} documentId - 文档ID
 */
export const deleteDocument = (collectionName, documentId) => {
  return del(`/api/vector/documents/${collectionName}/${documentId}`);
};

/**
 * 获取集合中的文档列表
 * @param {string} collectionName - 集合名称
 */
export const getDocuments = (collectionName) => {
  return get(`/api/vector/documents/${collectionName}`);
};

/**
 * 向量库健康检查
 */
export const healthCheck = () => {
  return get('/api/vector/health');
};
