/**
 * Agent 监控 API 模块
 */

const API_BASE = '/api/agent';

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.message || 'Request failed');
  }
  return result.data || result;
}

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
    return await requestJson(url, { method: 'GET' });
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
    return await requestJson(`${API_BASE}/metrics/reset`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
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
    const result = await requestJson(`${API_BASE}/sessions/${sessionId}/checkpoints`, { method: 'GET' });
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

    return await requestJson(`${API_BASE}/sessions/${sessionId}/recover`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
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
    return await requestJson(`${API_BASE}/approvals/${approvalId}/respond`, {
      method: 'POST',
      body: JSON.stringify({
        approved: approved
      })
    });
  } catch (error) {
    console.error('Error responding to approval:', error);
    throw error;
  }
}

export async function getExecutionOverview(activeOnly = true) {
  try {
    return await requestJson(`${API_BASE}/execution/overview?active_only=${activeOnly ? 'true' : 'false'}`, {
      method: 'GET'
    });
  } catch (error) {
    console.error('Error fetching execution overview:', error);
    throw error;
  }
}

export async function getRunningTasks() {
  try {
    return await requestJson(`${API_BASE}/tasks/running`, { method: 'GET' });
  } catch (error) {
    console.error('Error fetching running tasks:', error);
    throw error;
  }
}

export async function getTaskStatus(taskId) {
  try {
    return await requestJson(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/status`, { method: 'GET' });
  } catch (error) {
    console.error('Error fetching task status:', error);
    throw error;
  }
}

export async function getTaskExecutionDiagnostics(taskId) {
  try {
    return await requestJson(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/execution-diagnostics`, { method: 'GET' });
  } catch (error) {
    console.error('Error fetching task execution diagnostics:', error);
    throw error;
  }
}
