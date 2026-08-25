import { http } from './http.js';

const API_BASE = '/api/scheduler/tasks';

const taskPath = taskId => `${API_BASE}/${encodeURIComponent(taskId)}`;

export async function listSchedulerTasks() {
  const result = await http.get(API_BASE);
  return result.tasks || [];
}

export async function createSchedulerTask(task) {
  return http.post(API_BASE, task);
}

export async function updateSchedulerTask(taskId, updates) {
  return http.put(taskPath(taskId), updates);
}

export async function deleteSchedulerTask(taskId) {
  return http.del(taskPath(taskId));
}

export async function triggerSchedulerTask(taskId) {
  return http.post(`${taskPath(taskId)}/trigger`);
}

export async function getSchedulerTaskHistory(taskId, limit = 20) {
  return http.get(`${taskPath(taskId)}/history`, { params: { limit } });
}
