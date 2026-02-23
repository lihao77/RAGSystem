/**
 * Agent 监控 API 模块
 */

const API_BASE = '/api/agent';

/**
 * 获取系统性能指标
 * @param {string} agentName - 可选,指定智能体名称
 * @returns {Promise<Object>} 性能指标数据
 */
export async function getMetrics(agentName = null) {
  try {
    const url = agentName
      ? `${API_BASE}/metrics?agent_name=${encodeURIComponent(agentName)}`
      : `${API_BASE}/metrics`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to fetch metrics');
    }

    // 返回 data 字段的内容
    return result.data || result;
  } catch (error) {
    console.error('Error fetching metrics:', error);
    throw error;
  }
}

/**
 * 重置性能指标
 * @param {string} agentName - 可选,指定智能体名称
 * @returns {Promise<Object>} 重置结果
 */
export async function resetMetrics(agentName = null) {
  try {
    const body = agentName ? { agent_name: agentName } : {};

    const response = await fetch(`${API_BASE}/metrics/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to reset metrics');
    }

    return result.data || result;
  } catch (error) {
    console.error('Error resetting metrics:', error);
    throw error;
  }
}

/**
 * 获取会话检查点列表
 * @param {string} sessionId - 会话ID
 * @returns {Promise<Array>} 检查点列表
 */
export async function getCheckpoints(sessionId) {
  try {
    const response = await fetch(`${API_BASE}/sessions/${sessionId}/checkpoints`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to fetch checkpoints');
    }

    return result.checkpoints || result.data?.checkpoints || [];
  } catch (error) {
    console.error('Error fetching checkpoints:', error);
    throw error;
  }
}

/**
 * 从检查点恢复执行
 * @param {string} sessionId - 会话ID
 * @param {string} agentName - 智能体名称
 * @param {string} checkpointId - 可选,检查点ID
 * @returns {Promise<Object>} 恢复结果
 */
export async function recoverFromCheckpoint(sessionId, agentName, checkpointId = null) {
  try {
    const body = {
      agent_name: agentName
    };

    if (checkpointId) {
      body.checkpoint_id = checkpointId;
    }

    const response = await fetch(`${API_BASE}/sessions/${sessionId}/recover`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to recover from checkpoint');
    }

    return result.data || result;
  } catch (error) {
    console.error('Error recovering from checkpoint:', error);
    throw error;
  }
}

/**
 * 响应用户审批请求
 * @param {string} approvalId - 审批ID
 * @param {boolean} approved - 是否批准
 * @returns {Promise<Object>} 响应结果
 */
export async function respondToApproval(approvalId, approved) {
  try {
    const response = await fetch(`${API_BASE}/approvals/${approvalId}/respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        approved: approved
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Failed to respond to approval');
    }

    return result.data || result;
  } catch (error) {
    console.error('Error responding to approval:', error);
    throw error;
  }
}
