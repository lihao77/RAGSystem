/**
 * Skill bundle 文件规则：可编辑文本判定、相对路径校验、媒体类型推断、大小格式化。
 */

export function isEditableTextFile(file) {
  if (!file || file.size > 2 * 1024 * 1024) return false;
  return file.media_type?.startsWith('text/')
    || /(?:json|javascript|typescript|yaml|xml|sql)/i.test(file.media_type || '')
    || /\.(?:md|markdown|txt|py|js|ts|tsx|jsx|json|ya?ml|csv|sh|ps1|sql|css|html|vue|toml|ini|cfg)$/i.test(file.relative_path || '');
}

export function isValidRelativePath(value) {
  const normalized = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(normalized)
    && !normalized.startsWith('/')
    && !/^[A-Za-z]:/.test(normalized)
    && normalized.split('/').every((part) => part && part !== '.' && part !== '..');
}

/**
 * 与后端 requireSkillPath（skill-bundle.ts）对齐的可保存路径校验，比 isValidRelativePath 严：
 * 额外拒绝反斜杠、Windows 保留名（con/prn/aux/nul/com1-9/lpt1-9）、段尾点或空格、
 * `<>:"|?*` 与控制字符、超过 512 字符。导入时用它预检，避免保存才被 422。
 */
export function isValidSkillBundlePath(value) {
  const raw = String(value ?? '');
  if (!isValidRelativePath(raw) || raw.includes('\\') || raw.length > 512) return false;
  return raw.split('/').every((part) =>
    // 控制字符范围与后端 requireSkillPath 的禁字符表逐字对齐
    // eslint-disable-next-line no-control-regex
    !/[<>:"|?*\x00-\x1f]/.test(part)
    && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function guessMediaType(path) {
  const extension = path.split('.').pop()?.toLowerCase();
  return {
    md: 'text/markdown; charset=utf-8',
    markdown: 'text/markdown; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    py: 'text/x-python; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    ts: 'text/typescript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    yaml: 'text/yaml; charset=utf-8',
    yml: 'text/yaml; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
  }[extension] || 'text/plain; charset=utf-8';
}

export function formatSize(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
