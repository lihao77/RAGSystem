/**
 * MCP (Model Context Protocol) 管理 API 服务
 * 提供 MCP Server 的 CRUD、连接管理和工具查询接口
 */

import { get, post, put, del } from './http.js'

// ─── Server 列表与配置 CRUD ────────────────────────────────────────────────────

/**
 * 获取所有 MCP Server 及连接状态
 */
export async function listMCPServers() {
  return await get('/api/mcp/servers')
}

/**
 * 获取可安装的 MCP 模板列表
 */
export async function listMCPTemplates() {
  return await get('/api/mcp/templates')
}

/**
 * 搜索官方 MCP Registry
 * @param {Object} params 查询参数
 */
export async function listMCPRegistryServers(params = {}) {
  const query = new URLSearchParams()
  if (params.search) query.set('search', params.search)
  if (params.cursor) query.set('cursor', params.cursor)
  if (params.limit) query.set('limit', String(params.limit))
  query.set('latest_only', params.latest_only === false ? 'false' : 'true')
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return await get(`/api/mcp/registry/servers${suffix}`)
}

/**
 * 通过 Registry 搜索结果安装 MCP Server
 * @param {Object} payload 安装参数
 */
export async function installMCPRegistryServer(payload) {
  return await post('/api/mcp/registry/install', payload)
}

/**
 * 通过模板安装 MCP Server
 * @param {Object} payload 安装参数
 */
export async function installMCPServerFromTemplate(payload) {
  return await post('/api/mcp/templates/install', payload)
}

/**
 * 添加 MCP Server 配置
 * @param {Object} config 服务器配置
 */
export async function addMCPServer(config) {
  return await post('/api/mcp/servers', config)
}

/**
 * 更新 MCP Server 配置
 * @param {string} serverName 服务器名称
 * @param {Object} config 配置数据
 */
export async function updateMCPServer(serverName, config) {
  return await put(`/api/mcp/servers/${serverName}`, config)
}

/**
 * 删除 MCP Server 配置
 * @param {string} serverName 服务器名称
 */
export async function deleteMCPServer(serverName) {
  return await del(`/api/mcp/servers/${serverName}`)
}

// ─── 连接管理 ─────────────────────────────────────────────────────────────────

/**
 * 连接到指定 MCP Server
 * @param {string} serverName 服务器名称
 */
export async function connectMCPServer(serverName) {
  return await post(`/api/mcp/servers/${serverName}/connect`, {})
}

/**
 * 断开指定 MCP Server
 * @param {string} serverName 服务器名称
 */
export async function disconnectMCPServer(serverName) {
  return await post(`/api/mcp/servers/${serverName}/disconnect`, {})
}

/**
 * 测试 MCP Server 连接（断开并重连）
 * @param {string} serverName 服务器名称
 */
export async function testMCPServer(serverName) {
  return await post(`/api/mcp/servers/${serverName}/test`, {})
}

// ─── 工具查询 ─────────────────────────────────────────────────────────────────

/**
 * 获取指定 MCP Server 的工具列表
 * @param {string} serverName 服务器名称
 */
export async function getMCPServerTools(serverName) {
  return await get(`/api/mcp/servers/${serverName}/tools`)
}

/**
 * 获取所有已连接 MCP Server 的工具列表
 */
export async function getAllMCPTools() {
  return await get('/api/mcp/tools')
}

export default {
  listMCPServers,
  listMCPTemplates,
  listMCPRegistryServers,
  installMCPRegistryServer,
  installMCPServerFromTemplate,
  addMCPServer,
  updateMCPServer,
  deleteMCPServer,
  connectMCPServer,
  disconnectMCPServer,
  testMCPServer,
  getMCPServerTools,
  getAllMCPTools
}
