/**
 * 节点系统 API 服务
 */

import { get, post, del } from './http.js';

/**
 * 获取所有节点类型
 */
export async function getNodeTypes() {
  return await get('/api/nodes/types');
}

/**
 * 获取节点类型详情
 */
export async function getNodeType(nodeType) {
  return await get(`/api/nodes/types/${nodeType}`);
}

/**
 * 获取节点默认配置
 */
export async function getDefaultConfig(nodeType) {
  return await get(`/api/nodes/types/${nodeType}/default-config`);
}

/**
 * 获取所有保存的配置
 */
export async function getConfigs(nodeType = null, includePresets = true) {
  let url = '/api/nodes/configs';
  const params = [];
  if (nodeType) params.push(`node_type=${nodeType}`);
  if (!includePresets) params.push('include_presets=false');
  if (params.length > 0) url += '?' + params.join('&');
  return await get(url);
}

/**
 * 获取配置详情
 */
export async function getConfig(configId) {
  return await get(`/api/nodes/configs/${configId}`);
}

/**
 * 保存配置
 */
export async function saveConfig(data) {
  return await post('/api/nodes/configs', data);
}

/**
 * 删除配置
 */
export async function deleteConfig(configId) {
  return await del(`/api/nodes/configs/${configId}`);
}

/**
 * 执行节点
 */
export async function executeNode(data) {
  return await post('/api/nodes/execute', data);
}

/**
 * 获取内置处理器列表
 */
export async function getBuiltinProcessors() {
  return await get('/api/nodes/processors/builtin');
}

/**
 * 获取所有节点使用的数据类型
 * 用于动态生成全局变量类型选项
 */
export async function getDataTypes() {
  return await get('/api/nodes/data-types');
}

export default {
  getNodeTypes,
  getNodeType,
  getDefaultConfig,
  getConfigs,
  getConfig,
  saveConfig,
  deleteConfig,
  executeNode,
  getBuiltinProcessors,
  getDataTypes
};
