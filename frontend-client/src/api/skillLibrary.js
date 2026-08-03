/**
 * Skill 库管理 API
 * 列/看/改/建/删 skill 本体（文件目录管理）；写操作仅对用户全局 skill 生效。
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

export async function getSkillDraft(id) {
  const result = await http.get(`/api/skills/drafts/${encodeURIComponent(id)}`);
  return result.data || result;
}

export async function createSkillDraft({ name, description, content }) {
  const result = await http.post('/api/skills/drafts', { name, description, content });
  return result.data || result;
}

export async function updateSkillDraft(id, expectedRevision, { name, description, content }) {
  const result = await http.put(`/api/skills/drafts/${encodeURIComponent(id)}`, {
    expected_revision: expectedRevision,
    name,
    description,
    content,
  });
  return result.data || result;
}

export async function publishSkillDraft(id, expectedRevision) {
  const result = await http.post(`/api/skills/drafts/${encodeURIComponent(id)}/publish`, {
    expected_revision: expectedRevision,
  });
  return result.data || result;
}

export async function getSkillDetail(name) {
  return http.get(`/api/skills/${encodeURIComponent(name)}`);
}

export async function createSkill({ name, description, content }) {
  return http.post('/api/skills', { name, description, content: content ?? '' });
}

export async function updateSkill(name, { description, content }) {
  const body = {};
  if (description !== undefined) body.description = description;
  if (content !== undefined) body.content = content;
  return http.put(`/api/skills/${encodeURIComponent(name)}`, body);
}

export async function deleteSkill(name) {
  return http.del(`/api/skills/${encodeURIComponent(name)}`);
}

export async function uploadSkillFiles(name, files, dir = 'scripts') {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file, file.name);
  }
  const suffix = dir ? `?dir=${encodeURIComponent(dir)}` : '';
  return http.post(`/api/skills/${encodeURIComponent(name)}/files${suffix}`, formData);
}

export function getSkillFileUrl(name, relPath) {
  return `/api/skills/${encodeURIComponent(name)}/files?path=${encodeURIComponent(relPath)}`;
}
