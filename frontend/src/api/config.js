/**
 * 配置管理API服务
 * 提供配置读取、更新、验证和测试功能
 */

import * as http from './http'

/**
 * 获取当前配置（隐藏敏感信息）
 */
export function getConfig() {
  return http.get('/api/config/')
}

/**
 * 获取原始配置（包含敏感信息）
 */
export function getRawConfig() {
  return http.get('/api/config/raw')
}

/**
 * 更新配置
 * @param {Object} configData - 新的配置数据
 */
export function updateConfig(configData) {
  return http.put('/api/config/', configData)
}

/**
 * 验证配置格式
 * @param {Object} configData - 待验证的配置数据
 */
export function validateConfig(configData) {
  return http.post('/api/config/validate', configData)
}

/**
 * 测试Neo4j连接
 * @param {Object} neo4jConfig - Neo4j配置（可选）
 */
export function testNeo4jConnection(neo4jConfig = null) {
  return http.post('/api/config/test/neo4j', neo4jConfig ? { neo4j: neo4jConfig } : {})
}

/**
 * 测试LLM API连接
 * @param {Object} llmConfig - LLM配置（可选）
 */
export function testLLMConnection(llmConfig = null) {
  return http.post('/api/config/test/llm', llmConfig ? { llm: llmConfig } : {})
}

/**
 * 热重载配置
 */
export function reloadConfig() {
  return http.post('/api/config/reload')
}

/**
 * 导出配置
 */
export function exportConfig() {
  return http.get('/api/config/export')
}

/**
 * 获取配置模式（用于表单生成）
 */
export function getConfigSchema() {
  return http.get('/api/config/schema')
}

/**
 * 获取所有服务的状态
 */
export function getServicesStatus() {
  return http.get('/api/config/services/status')
}

/**
 * 重新初始化指定服务
 * @param {string} serviceKey - 服务标识符 ('neo4j', 'vector', 'llm')
 */
export function reinitService(serviceKey) {
  return http.post(`/api/config/services/${serviceKey}/reinit`)
}

export default {
  getConfig,
  getRawConfig,
  updateConfig,
  validateConfig,
  testNeo4jConnection,
  testLLMConnection,
  reloadConfig,
  exportConfig,
  getConfigSchema,
  getServicesStatus,
  reinitService
}
