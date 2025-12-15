/**
 * 工作流 API 服务
 */

import { get, post, del } from './http.js';

export async function listWorkflows() {
  return await get('/api/workflows');
}

export async function getWorkflow(id) {
  return await get(`/api/workflows/${id}`);
}

export async function saveWorkflow(workflow) {
  return await post('/api/workflows', workflow);
}

export async function deleteWorkflow(id) {
  return await del(`/api/workflows/${id}`);
}

export async function runWorkflow(id, initialInputs = {}) {
  return await post(`/api/workflows/${id}/run`, { initial_inputs: initialInputs });
}

export default {
  listWorkflows,
  getWorkflow,
  saveWorkflow,
  deleteWorkflow,
  runWorkflow
};
