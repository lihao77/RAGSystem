/**
 * 守护 Agent 系统 API
 */

const API_BASE = '/api/daemon';

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.detail || result.message || '请求失败');
  }
  return result;
}

export async function getStatus() {
  return requestJson(`${API_BASE}/status`);
}

export async function getConfig() {
  return requestJson(`${API_BASE}/config`);
}

export async function updateConfig(config) {
  return requestJson(`${API_BASE}/config`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export async function startDaemon() {
  return requestJson(`${API_BASE}/start`, { method: 'POST' });
}

export async function stopDaemon() {
  return requestJson(`${API_BASE}/stop`, { method: 'POST' });
}

export async function listAgents() {
  return requestJson(`${API_BASE}/agents`);
}

export async function getAgentHeartbeat(agentName, limit = 20) {
  return requestJson(`${API_BASE}/agents/${agentName}/heartbeat?limit=${limit}`);
}

export async function testAgent(agentName, { content, platform, chat_id } = {}) {
  return requestJson(`${API_BASE}/agents/${agentName}/test`, {
    method: 'POST',
    body: JSON.stringify({ content, platform, chat_id }),
  });
}

export async function sendDaemonMessage({ platform, chat_id, content, message_type }) {
  return requestJson(`${API_BASE}/send`, {
    method: 'POST',
    body: JSON.stringify({ platform, chat_id, content, message_type }),
  });
}

export async function listCronTasks() {
  return requestJson(`${API_BASE}/cron/tasks`);
}

export async function createCronTask(task) {
  return requestJson(`${API_BASE}/cron/tasks`, {
    method: 'POST',
    body: JSON.stringify(task),
  });
}

export async function updateCronTask(taskId, updates) {
  return requestJson(`${API_BASE}/cron/tasks/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export async function deleteCronTask(taskId) {
  return requestJson(`${API_BASE}/cron/tasks/${taskId}`, {
    method: 'DELETE',
  });
}

export async function triggerCronTask(taskId) {
  return requestJson(`${API_BASE}/cron/tasks/${taskId}/trigger`, {
    method: 'POST',
  });
}

export async function getCronTaskHistory(taskId, limit = 20) {
  return requestJson(`${API_BASE}/cron/tasks/${taskId}/history?limit=${limit}`);
}
