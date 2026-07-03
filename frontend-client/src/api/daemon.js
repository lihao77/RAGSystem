/**
 * 守护 Agent 系统 API
 */

import { http } from './http.js';

const API_BASE = '/api/daemon';

export async function getStatus() {
  return http.get(`${API_BASE}/status`);
}

export async function getConfig() {
  return http.get(`${API_BASE}/config`);
}

export async function updateConfig(config) {
  return http.put(`${API_BASE}/config`, config);
}

export async function startDaemon() {
  return http.post(`${API_BASE}/start`);
}

export async function stopDaemon() {
  return http.post(`${API_BASE}/stop`);
}

export async function listAgents() {
  return http.get(`${API_BASE}/agents`);
}

export async function getAgentHeartbeat(agentName, limit = 20) {
  return http.get(`${API_BASE}/agents/${agentName}/heartbeat?limit=${limit}`);
}

export async function testAgent(agentName, { content, platform, chat_id } = {}) {
  return http.post(`${API_BASE}/agents/${agentName}/test`, { content, platform, chat_id });
}

export async function sendDaemonMessage({ platform, chat_id, content, message_type }) {
  return http.post(`${API_BASE}/send`, { platform, chat_id, content, message_type });
}

export async function listCronTasks() {
  return http.get(`${API_BASE}/cron/tasks`);
}

export async function createCronTask(task) {
  return http.post(`${API_BASE}/cron/tasks`, task);
}

export async function updateCronTask(taskId, updates) {
  return http.put(`${API_BASE}/cron/tasks/${taskId}`, updates);
}

export async function deleteCronTask(taskId) {
  return http.del(`${API_BASE}/cron/tasks/${taskId}`);
}

export async function triggerCronTask(taskId) {
  return http.post(`${API_BASE}/cron/tasks/${taskId}/trigger`);
}

export async function getCronTaskHistory(taskId, limit = 20) {
  return http.get(`${API_BASE}/cron/tasks/${taskId}/history?limit=${limit}`);
}
