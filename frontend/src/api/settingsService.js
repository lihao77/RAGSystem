/**
 * 系统设置相关API服务
 */

import { get, post } from './http';

/**
 * 获取系统配置
 * @returns {Promise<object>} 系统配置信息
 */
export async function getSettings() {
  return await get('/api/settings');
}

/**
 * 保存系统配置
 * @param {object} settings - 系统配置信息
 * @returns {Promise<object>} 保存结果
 */
export async function saveSettings(settings) {
  return await post('/api/settings', settings);
}

/**
 * 测试Neo4j连接
 * @param {object} config - Neo4j连接配置
 * @returns {Promise<object>} 测试结果
 */
export async function testNeo4jConnection(config) {
  return await post('/api/settings/test-neo4j', config);
}

/**
 * 测试LLM服务连接
 * @param {object} config - LLM服务配置
 * @returns {Promise<object>} 测试结果
 */
export async function testLLMConnection(config) {
  return await post('/api/settings/test-llm', config);
}

