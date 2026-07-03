/**
 * Agent 监控 API 模块
 */

import { http } from './http.js';

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
    const result = await http.get(url);
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
    const result = await http.post(`${API_BASE}/metrics/reset`, body);
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
    const result = await http.get(`${API_BASE}/sessions/${sessionId}/checkpoints`);
    const extracted = result.data || result;
    return extracted.checkpoints || result.data?.checkpoints || [];
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

    const result = await http.post(`${API_BASE}/sessions/${sessionId}/recover`, body);
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
    const result = await http.post(`${API_BASE}/approvals/${approvalId}/respond`, {
      approved: approved
    });
    return result.data || result;
  } catch (error) {
    console.error('Error responding to approval:', error);
    throw error;
  }
}

export async function getExecutionOverview(activeOnly = true) {
  try {
    const result = await http.get(`${API_BASE}/execution/overview?active_only=${activeOnly ? 'true' : 'false'}`);
    return result.data || result;
  } catch (error) {
    console.error('Error fetching execution overview:', error);
    throw error;
  }
}

export async function getRunningTasks() {
  try {
    const result = await http.get(`${API_BASE}/tasks/running`);
    return result.data || result;
  } catch (error) {
    console.error('Error fetching running tasks:', error);
    throw error;
  }
}

export async function getTaskStatus(taskId) {
  try {
    const result = await http.get(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/status`);
    return result.data || result;
  } catch (error) {
    console.error('Error fetching task status:', error);
    throw error;
  }
}

export async function getTaskExecutionDiagnostics(taskId) {
  try {
    const result = await http.get(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/execution-diagnostics`);
    return result.data || result;
  } catch (error) {
    console.error('Error fetching task execution diagnostics:', error);
    throw error;
  }
}

export async function getToolCallRawResult(sessionId, callId) {
  try {
    const result = await http.get(
      `${API_BASE}/tool-call/raw-result?session_id=${encodeURIComponent(sessionId)}&call_id=${encodeURIComponent(callId)}`
    );
    return result.data || result;
  } catch (error) {
    console.error('Error fetching tool call raw result:', error);
    throw error;
  }
}

export async function getMessageRunSteps(sessionId, messageId, { limit = 500, offset = 0 } = {}) {
  try {
    const result = await http.get(
      `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/run-steps?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`
    );
    return result.data || result;
  } catch (error) {
    console.error('Error fetching message run steps:', error);
    throw error;
  }
}
