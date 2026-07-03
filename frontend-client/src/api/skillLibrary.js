/**
 * Skill 库管理 API
 * 列/看/改/建/删 skill 本体（文件目录管理）；写操作仅对用户全局 skill 生效。
 */

import { http } from './http.js';

export async function listSkills() {
  return http.get('/api/skills');
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
