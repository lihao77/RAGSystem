/**
 * Skill bundle 文件规则：可编辑文本判定、相对路径校验、媒体类型推断、大小格式化。
 */

export function isEditableTextFile(file) {
  if (!file || file.size > 2 * 1024 * 1024) return false;
  return file.media_type?.startsWith('text/')
    || /(?:json|javascript|typescript|yaml|xml|sql)/i.test(file.media_type || '')
    || /\.(?:md|txt|py|js|ts|tsx|jsx|json|ya?ml|csv|sh|ps1|sql|css|html|vue|toml|ini|cfg)$/i.test(file.relative_path || '');
}

export function isValidRelativePath(value) {
  const normalized = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(normalized)
    && !normalized.startsWith('/')
    && !/^[A-Za-z]:/.test(normalized)
    && normalized.split('/').every((part) => part && part !== '.' && part !== '..');
}

export function guessMediaType(path) {
  const extension = path.split('.').pop()?.toLowerCase();
  return {
    md: 'text/markdown; charset=utf-8',
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
