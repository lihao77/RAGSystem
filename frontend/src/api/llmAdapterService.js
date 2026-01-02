/**
 * LLM Adapter API 服务
 * 提供与LLM Adapter配置管理相关的API接口
 */

import { get, post, put, del } from './http.js';

/**
 * 获取所有 Provider 列表
 */
export async function getProviders() {
  return await get('/api/llm-adapter/providers');
}

/**
 * 创建新的 Provider
 * @param {Object} data Provider配置数据
 */
export async function createProvider(data) {
  return await post('/api/llm-adapter/providers', data);
}

/**
 * 更新 Provider
 * @param {string} name Provider名称
 * @param {Object} data Provider配置数据
 */
export async function updateProvider(name, data) {
  return await put(`/api/llm-adapter/providers/${name}`, data);
}

/**
 * 删除 Provider
 * @param {string} name Provider名称
 */
export async function deleteProvider(name) {
  return await del(`/api/llm-adapter/providers/${name}`);
}

/**
 * 设置活动 Provider（单个，已废弃，建议使用setActiveProviders）
 * @param {string} name Provider名称
 */
export async function setActiveProvider(name) {
  return await post('/api/llm-adapter/active-provider', { provider: name });
}

/**
 * 设置活动 Provider 列表
 * @param {Array<string>} providerNames Provider名称列表
 */
export async function setActiveProviders(providerNames) {
  return await post('/api/llm-adapter/active-providers', {
    providers: providerNames
  });
}

/**
 * 测试 Provider
 * @param {Object} data 测试数据 { provider, prompt }
 */
export async function testProvider(data) {
  return await post('/api/llm-adapter/test', data);
}

/**
 * 设置负载均衡策略
 * @param {string} strategy 策略名称（round_robin, random）
 */
export async function setLoadBalancer(strategy) {
  return await post('/api/llm-adapter/load-balancer', { strategy });
}

export default {
  getProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  setActiveProviders,
  testProvider,
  setLoadBalancer
};
