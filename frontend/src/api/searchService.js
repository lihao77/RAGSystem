/**
 * 实体查询相关API服务
 */

import { get, post } from './http';

/**
 * 搜索实体
 * @param {object} searchParams - 搜索参数
 * @returns {Promise<Array>} 搜索结果
 */
export async function getGeoCode() {
  try {
    const response = await fetch('/api/src/assets/admin_codes.json');
    if (!response.ok) {
      throw new Error(`请求失败: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('API请求错误:', error);
    throw error;
  }
}

/**
 * 搜索实体
 * @param {object} searchParams - 搜索参数
 * @returns {Promise<Array>} 搜索结果
 */
export async function searchEntities(searchParams) {
  return await post('/api/search/entities', searchParams);
}

/**
 * 获取实体关系
 * @param {string} entityId - 实体ID
 * @returns {Promise<Array>} 关系列表
 */
export async function getEntityRelations(entityId) {
  return await get(`/api/search/relations/${entityId}`);
}

/**
 * 导出搜索结果
 * @param {Array} results - 要导出的结果
 * @returns {Promise<object>} 导出结果
 */
export async function exportResults(results) {
  return await post('/api/search/export', { results });
}

/**
 * 获取地理位置选项
 * @returns {Promise<Array>} 地理位置选项
 */
export async function getLocationOptions() {
  return await get('/api/search/location-options');
}

/**
 * 获取文档来源列表
 * @returns {Promise<Array>} 文档来源列表
 */
export async function getDocumentSources() {
  return await get('/api/search/document-sources');
}