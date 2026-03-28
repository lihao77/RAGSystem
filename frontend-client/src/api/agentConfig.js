/**
 * Agent 配置 API 模块
 */

const API_BASE = '/api/agent-config';

/**
 * 获取所有智能体配置
 * @returns {Promise<Object>} 配置映射
 */
export async function getAllAgentConfigs() {
  try {
    const response = await fetch(`${API_BASE}/configs`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to fetch agent configs');
    }

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
    const response = await fetch(`${API_BASE}/configs/${encodeURIComponent(agentName)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to fetch agent config');
    }

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
    const response = await fetch(`${API_BASE}/configs/${encodeURIComponent(agentName)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to update agent config');
    }

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
    const response = await fetch(`/api/agent/agents/delete/${encodeURIComponent(agentName)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.detail || result.message || 'Failed to delete agent');
    }
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
    const response = await fetch(`${API_BASE}/tools`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to fetch available tools');
    }

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
export async function getAvailableSkills() {
  try {
    const response = await fetch(`${API_BASE}/skills`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to fetch available skills');
    }

    return result.data || [];
  } catch (error) {
    console.error('Error fetching available skills:', error);
    throw error;
  }
}

/**
 * 创建新智能体
 * @param {Object} payload - { agent_name, display_name?, description? }
 * @returns {Promise<Object>} 新建的智能体配置
 */
export async function createAgent(payload) {
  try {
    const response = await fetch('/api/agent/agents/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.detail || result.message || 'Failed to create agent');
    }
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
    const response = await fetch(`${API_BASE}/memory-metadata`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to fetch memory config metadata');
    }

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
    const response = await fetch(`${API_BASE}/mcp-servers`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to fetch available MCP servers');
    }

    return result.data || [];
  } catch (error) {
    console.error('Error fetching available MCP servers:', error);
    throw error;
  }
}
