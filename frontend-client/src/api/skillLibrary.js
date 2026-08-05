/**
 * Skill 库管理 API。
 * Draft 编辑发布与租户 Skill 包读取/删除；已发布 bundle 通过其 Draft 更新。
 */

import { http } from './http.js';

const AGENT_CONFIG_BASE = '/api/skills/agents';

function agentConfigUrl(agentName, teamName) {
  const query = teamName ? `?team=${encodeURIComponent(teamName)}` : '';
  return `${AGENT_CONFIG_BASE}/${encodeURIComponent(agentName)}/config${query}`;
}

export async function getSkillsAgentConfig(agentName, teamName = '') {
  const result = await http.get(agentConfigUrl(agentName, teamName));
  return result.data || result;
}

export async function updateSkillsAgentConfig(agentName, config, teamName = '') {
  const result = await http.put(agentConfigUrl(agentName, teamName), config);
  return result.data || result;
}

export async function resetSkillsAgentConfig(agentName, teamName = '') {
  const result = await http.del(agentConfigUrl(agentName, teamName));
  return result.data || result;
}

export async function getAvailableSkills(workspaceRoot = '') {
  const query = workspaceRoot ? `?workspace_root=${encodeURIComponent(workspaceRoot)}` : '';
  const result = await http.get(`/api/skills/available${query}`);
  return result.data || [];
}

export async function listSkills() {
  return http.get('/api/skills');
}

export async function listSkillDrafts() {
  const result = await http.get('/api/skills/drafts');
  return result.data || [];
}

export async function createSkillDraft(name, description) {
  const result = await http.post('/api/skills/drafts', { name, description });
  return result.data || result;
}

export async function getSkillDraft(id) {
  const result = await http.get(`/api/skills/drafts/${encodeURIComponent(id)}`);
  return result.data || result;
}

export async function updateSkillDraft(id, expectedRevision, content) {
  const result = await http.put(`/api/skills/drafts/${encodeURIComponent(id)}`, {
    expected_revision: expectedRevision,
    name: content.name,
    description: content.description,
    content: content.content,
  });
  return result.data || result;
}

export async function ensureSkillDraft(name) {
  const result = await http.post(`/api/skills/${encodeURIComponent(name)}/draft`, {});
  return result.data || result;
}

export async function publishSkillDraft(id, expectedRevision) {
  const result = await http.post(`/api/skills/drafts/${encodeURIComponent(id)}/publish`, {
    expected_revision: expectedRevision,
  });
  return result.data || result;
}

export async function deleteSkillDraft(id) {
  const result = await http.del(`/api/skills/drafts/${encodeURIComponent(id)}`);
  return result.data || result;
}

export async function getSkillDetail(name) {
  return http.get(`/api/skills/${encodeURIComponent(name)}`);
}

export async function deleteSkill(name) {
  return http.del(`/api/skills/${encodeURIComponent(name)}`);
}

export function getSkillFileUrl(name, relPath) {
  return `/api/skills/${encodeURIComponent(name)}/files?path=${encodeURIComponent(relPath)}`;
}
