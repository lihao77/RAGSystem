/**
 * Skill 库管理 API
 * 列/看/改/建/删 skill 本体（文件目录管理）；写操作仅对用户全局 skill 生效。
 */

async function parseResponse(response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.detail || result.message || `请求失败: ${response.status}`);
  }
  return result;
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  // 仅在请求携带 body 时声明 JSON content-type；无 body 的 DELETE 若声明会被 Fastify 拒。
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  if (options.body !== undefined && !hasContentType) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, { ...options, headers });
  return parseResponse(response);
}

export async function listSkills() {
  return request('/api/skills');
}

export async function getSkillDetail(name) {
  return request(`/api/skills/${encodeURIComponent(name)}`);
}

export async function createSkill({ name, description, content }) {
  return request('/api/skills', {
    method: 'POST',
    body: JSON.stringify({ name, description, content: content ?? '' }),
  });
}

export async function updateSkill(name, { description, content }) {
  const body = {};
  if (description !== undefined) body.description = description;
  if (content !== undefined) body.content = content;
  return request(`/api/skills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteSkill(name) {
  return request(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export async function uploadSkillFiles(name, files, dir = 'scripts') {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file, file.name);
  }
  const suffix = dir ? `?dir=${encodeURIComponent(dir)}` : '';
  const response = await fetch(`/api/skills/${encodeURIComponent(name)}/files${suffix}`, {
    method: 'POST',
    body: formData,
  });
  return parseResponse(response);
}

export function getSkillFileUrl(name, relPath) {
  return `/api/skills/${encodeURIComponent(name)}/files?path=${encodeURIComponent(relPath)}`;
}
