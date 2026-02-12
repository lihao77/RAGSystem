/**
 * Embedding 模型管理服务
 */

import { get, post, del } from './http';

/**
 * 获取所有模型列表
 */
export const getModels = () => {
  return get('/api/embedding-models/models');
};

/**
 * 激活指定模型
 * @param {number} modelId - 模型ID
 */
export const activateModel = (modelId) => {
  return post(`/api/embedding-models/models/${modelId}/activate`);
};

/**
 * 删除指定模型
 * @param {number} modelId - 模型ID
 * @param {boolean} force - 是否强制删除
 */
export const deleteModel = (modelId, force = false) => {
  return del(`/api/embedding-models/models/${modelId}?force=${force}`);
};

/**
 * 同步文档到指定模型
 * @param {number} modelId - 模型ID
 * @param {Object} params - 同步参数
 * @param {string} params.collection - 集合名称
 * @param {number} params.batch_size - 批处理大小
 * @param {number} params.limit - 限制数量
 */
export const syncModel = (modelId, params) => {
  return post(`/api/embedding-models/models/${modelId}/sync`, params);
};

/**
 * 获取模型统计信息
 * @param {number} modelId - 模型ID
 * @param {string} collection - 集合名称（可选）
 */
export const getModelStats = (modelId, collection) => {
  let url = `/api/embedding-models/models/${modelId}/stats`;
  if (collection) {
    url += `?collection=${collection}`;
  }
  return get(url);
};

/**
 * 获取所有模型的同步状态
 * @param {string} collection - 集合名称（可选）
 */
export const getSyncStatus = (collection) => {
  let url = '/api/embedding-models/models/sync-status';
  if (collection) {
    url += `?collection=${collection}`;
  }
  return get(url);
};
