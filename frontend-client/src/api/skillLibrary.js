/**
 * Skill 库管理 API。
 * 完整 Skill 包的读取、保存和删除；保存后直接生效。
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

export async function getSkillBundle(name) {
  const result = await http.get(`/api/skills/${encodeURIComponent(name)}/bundle`);
  return result.data || result;
}

export async function saveSkillBundle(name, expectedRevision, files) {
  const result = await http.put(`/api/skills/${encodeURIComponent(name)}/bundle`, {
    expected_revision: expectedRevision,
    files: files.map(({ relative_path, media_type, body_base64 }) => ({ relative_path, media_type, body_base64 })),
  });
  return result.data || result;
}

export async function getSkillDetail(name) {
  return http.get(`/api/skills/${encodeURIComponent(name)}`);
}

export async function deleteSkill(name, expectedRevision) {
  return http.del(`/api/skills/${encodeURIComponent(name)}`, { params: { expected_revision: expectedRevision } });
}

export function getSkillFileUrl(name, relPath) {
  return `/api/skills/${encodeURIComponent(name)}/files?path=${encodeURIComponent(relPath)}`;
}
