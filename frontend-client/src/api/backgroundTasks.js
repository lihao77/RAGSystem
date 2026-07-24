/** Session-scoped background task APIs used by the runtime center. */

import { http } from './http.js';

const BASE = '/api/agent/sessions';

function taskBase(sessionId) {
  return `${BASE}/${encodeURIComponent(sessionId)}/background-tasks`;
}

export async function getSessionBackgroundTasks(sessionId, { signal } = {}) {
  return http.get(taskBase(sessionId), { signal });
}

export async function cancelSessionBackgroundTask(sessionId, taskId) {
  return http.post(`${taskBase(sessionId)}/${encodeURIComponent(taskId)}/cancel`);
}

export async function cancelSessionBackgroundTasks(sessionId, taskIds) {
  return http.post(`${taskBase(sessionId)}/cancel`, { task_ids: taskIds });
}

