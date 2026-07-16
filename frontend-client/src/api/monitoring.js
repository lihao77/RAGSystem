/**
 * Agent 监控 API 模块
 */

import { http } from './http.js';
export { getMessageRunSteps } from './session-contracts.ts';

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
