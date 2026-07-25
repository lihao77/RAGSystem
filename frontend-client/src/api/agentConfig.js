/**
 * Agent 配置 API 模块
 */

import { http } from './http.js';

const API_BASE = '/api/agent-config';


export async function getTeams() {
  try {
    const result = await http.get(`${API_BASE}/teams`);
    return result.data || { active_team: '', teams: [] };
  } catch (error) {
    console.error('Error fetching teams:', error);
    throw error;
  }
}

export async function createTeam(payload) {
  try {
    const result = await http.post(`${API_BASE}/teams`, payload);
    return result.data || result;
  } catch (error) {
    console.error('Error creating team:', error);
    throw error;
  }
}

export async function activateTeam(teamName) {
  try {
    const result = await http.post(`${API_BASE}/teams/${encodeURIComponent(teamName)}/activate`);
    return result.data || result;
  } catch (error) {
    console.error('Error activating team:', error);
    throw error;
  }
}

export async function deleteTeam(teamName) {
  try {
    const result = await http.del(`${API_BASE}/teams/${encodeURIComponent(teamName)}`);
    return result.data || result;
  } catch (error) {
    console.error('Error deleting team:', error);
    throw error;
  }
}

export async function renameTeam(teamName, newTeamName) {
  try {
    const result = await http.patch(`${API_BASE}/teams/${encodeURIComponent(teamName)}/rename`, {
      new_team_name: newTeamName
    });
    return result.data || result;
  } catch (error) {
    console.error('Error renaming team:', error);
    throw error;
  }
}

export async function copyAgentsToTeam(teamName, sourceTeam, agentNames) {
  try {
    const result = await http.post(`${API_BASE}/teams/${encodeURIComponent(teamName)}/copy-agents`, {
      source_team: sourceTeam,
      agent_names: agentNames
    });
    return result.data || result;
  } catch (error) {
    console.error('Error copying agents to team:', error);
    throw error;
  }
}

export async function resetDefaultTeam() {
  try {
    const result = await http.post(`${API_BASE}/teams/default/reset`);
    return result.data || result;
  } catch (error) {
    console.error('Error resetting default team:', error);
    throw error;
  }
}

/**
 * 获取智能体配置
 * @param {string} [teamName] - 指定 team；省略则返回当前激活 team
 * @returns {Promise<Object>} 配置映射
 */
export async function getAllAgentConfigs(teamName) {
  try {
    const team = typeof teamName === 'string' ? teamName.trim() : '';
    const query = team ? `?team=${encodeURIComponent(team)}` : '';
    const result = await http.get(`${API_BASE}/configs${query}`);
    return result.data || result;
  } catch (error) {
    console.error('Error fetching agent configs:', error);
    throw error;
  }
}

/**
 * 获取单个智能体配置
 * @param {string} agentName - 智能体名称
 * @returns {Promise<Object>} 智能体配置
 */
export async function getAgentConfig(agentName) {
  try {
    const result = await http.get(`${API_BASE}/configs/${encodeURIComponent(agentName)}`);
    return result.data || result;
  } catch (error) {
    console.error('Error fetching agent config:', error);
    throw error;
  }
}

/**
 * 更新智能体配置
 * @param {string} agentName - 智能体名称
 * @param {Object} payload - 完整配置
 * @returns {Promise<Object>} 更新后的配置
 */
export async function updateAgentConfig(agentName, payload) {
  try {
    const result = await http.put(`${API_BASE}/configs/${encodeURIComponent(agentName)}`, payload);
    return result.data || result;
  } catch (error) {
    console.error('Error updating agent config:', error);
    throw error;
  }
}

/**
 * 删除智能体
 * @param {string} agentName - 智能体名称
 */
export async function deleteAgent(agentName) {
  try {
    const result = await http.del(`/api/agent/agents/delete/${encodeURIComponent(agentName)}`);
    return result;
  } catch (error) {
    console.error('Error deleting agent:', error);
    throw error;
  }
}

/**
 * 获取可用工具列表
 * @returns {Promise<Array>} 工具列表
 */
export async function getAvailableTools() {
  try {
    const result = await http.get(`${API_BASE}/tools`);
    return result.data || [];
  } catch (error) {
    console.error('Error fetching available tools:', error);
    throw error;
  }
}

/**
 * 获取可用 Skill 列表
 * @returns {Promise<Array>} Skill 列表
 */
export async function getAvailableSkills(workspaceRoot = '') {
  try {
    const query = workspaceRoot ? `?workspace_root=${encodeURIComponent(workspaceRoot)}` : '';
    const result = await http.get(`${API_BASE}/skills${query}`);
    return result.data || [];
  } catch (error) {
    console.error('Error fetching available skills:', error);
    throw error;
  }
}

/**
 * 导出 agent 配置为 yaml（blob 下载）。返回 { blob, headers }，调用方触发下载。
 */
export async function exportAgentConfig(agentName, { format = 'yaml' } = {}) {
  const resp = await http.getRaw(
    `${API_BASE}/configs/${encodeURIComponent(agentName)}/export?format=${encodeURIComponent(format)}`,
    { responseType: 'blob' },
  );
  return { blob: resp.data, headers: resp.headers };
}

/**
 * 创建新智能体
 * @param {Object} payload - { agent_name, display_name?, description? }
 * @returns {Promise<Object>} 新建的智能体配置
 */
export async function createAgent(payload) {
  try {
    const result = await http.post('/api/agent/agents/create', payload);
    return result.data || result;
  } catch (error) {
    console.error('Error creating agent:', error);
    throw error;
  }
}

/**
 * 获取 Memory 配置元数据
 * @returns {Promise<Object>} Memory scope 说明
 */
export async function getMemoryConfigMetadata() {
  try {
    const result = await http.get(`${API_BASE}/memory-metadata`);
    return result.data || { scopes: [] };
  } catch (error) {
    console.error('Error fetching memory config metadata:', error);
    throw error;
  }
}

/**
 * 获取可供智能体使用的 MCP Server 列表
 * @returns {Promise<Array>} MCP Server 列表
 */
export async function getAvailableMCPServers() {
  try {
    const result = await http.get(`${API_BASE}/mcp-servers`);
    return result.data || [];
  } catch (error) {
    console.error('Error fetching available MCP servers:', error);
    throw error;
  }
}
