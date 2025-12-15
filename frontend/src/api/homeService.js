/**
 * 首页相关API服务
 */

import { get } from './http';

/**
 * 获取知识图谱统计数据
 * @returns {Promise<object>} 统计数据
 */
export async function getGraphStats() {
  return await get('/api/home/stats');
}

/**
 * 获取最近处理的文档列表
 * @returns {Promise<Array>} 文档列表
 */
export async function getRecentDocuments() {
  return await get('/api/home/recent-documents');
}

/**
 * 获取文档详情
 * @param {string} documentId - 文档ID
 * @returns {Promise<object>} 文档详情
 */
export async function getDocumentDetails(documentId) {
  return await get(`/api/home/document/${documentId}`);
}