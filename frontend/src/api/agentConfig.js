/**
 * 智能体配置管理 API 服务
 * 提供智能体配置的 CRUD 接口
 */

import { get, post, put, patch, del } from './http.js'

/**
 * 创建新智能体
 * @param {Object} agentConfig 智能体配置
 */
export async function createAgent(agentConfig) {
  return await post('/api/agent/agents/create', agentConfig)
}

/**
 * 获取所有智能体配置
 */
export async function getAllAgentConfigs() {
  return await get('/api/agent-config/configs')
}

/**
 * 获取指定智能体配置
 * @param {string} agentName 智能体名称
 */
export async function getAgentConfig(agentName) {
  return await get(`/api/agent-config/configs/${agentName}`)
}

/**
 * 更新智能体配置（完整更新）
 * @param {string} agentName 智能体名称
 * @param {Object} config 配置数据
 */
export async function updateAgentConfig(agentName, config) {
  return await put(`/api/agent-config/configs/${agentName}`, config)
}

/**
 * 更新智能体配置（部分更新）
 * @param {string} agentName 智能体名称
 * @param {Object} updates 更新的字段
 */
export async function patchAgentConfig(agentName, updates) {
  return await patch(`/api/agent-config/configs/${agentName}`, updates)
}

/**
 * 删除智能体
 * @param {string} agentName 智能体名称
 */
export async function deleteAgent(agentName) {
  return await del(`/api/agent/agents/delete/${agentName}`)
}

/**
 * 删除智能体配置（已弃用，请使用 deleteAgent）
 * @param {string} agentName 智能体名称
 */
export async function deleteAgentConfig(agentName) {
  return await del(`/api/agent-config/configs/${agentName}`)
}

/**
 * 应用预设配置
 * @param {string} agentName 智能体名称
 * @param {string} preset 预设名称 (fast, balanced, accurate, creative, cheap)
 */
export async function applyPreset(agentName, preset) {
  return await post(`/api/agent-config/configs/${agentName}/preset`, { preset })
}

/**
 * 导出智能体配置
 * @param {string} agentName 智能体名称
 * @param {string} format 格式 (yaml, json)
 */
export async function exportAgentConfig(agentName, format = 'yaml') {
  const url = `/api/agent-config/configs/${agentName}/export?format=${format}`
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000'}${url}`)
  return await response.text()
}

/**
 * 导入智能体配置
 * @param {string} agentName 智能体名称
 * @param {string} configText 配置文本
 * @param {string} format 格式 (yaml, json)
 */
export async function importAgentConfig(agentName, configText, format = 'yaml') {
  const url = `/api/agent-config/configs/${agentName}/import?format=${format}`
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000'}${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': format === 'yaml' ? 'application/x-yaml' : 'application/json'
    },
    body: configText
  })
  return await response.json()
}

/**
 * 验证智能体配置
 * @param {string} agentName 智能体名称
 */
export async function validateAgentConfig(agentName) {
  return await get(`/api/agent-config/configs/${agentName}/validate`)
}

/**
 * 获取所有预设
 */
export async function getPresets() {
  return await get('/api/agent-config/presets')
}

/**
 * 获取所有可用的工具列表
 */
export async function getAvailableTools() {
  return await get('/api/agent-config/tools')
}

export default {
  getAllAgentConfigs,
  getAgentConfig,
  updateAgentConfig,
  patchAgentConfig,
  deleteAgentConfig,
  applyPreset,
  exportAgentConfig,
  importAgentConfig,
  validateAgentConfig,
  getPresets,
  getAvailableTools,
  createAgent,
  deleteAgent
}
