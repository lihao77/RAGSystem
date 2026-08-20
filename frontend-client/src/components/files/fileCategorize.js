/**
 * file_ref 展示类别判定
 *
 * 依据扩展名（优先）与 content-type（兜底）把 workspace 文件归入展示类别，
 * 供 VisualizationLoader 按 presentation × category 分发到对应渲染器。
 * 代码语言的映射对齐 utils/markdown.js 中已注册的 highlight.js 语言与别名。
 */

/** 文本类内容（md/code/json/csv）内联渲染的最大字节 数，超出截断并提示。 */
export const TEXT_PREVIEW_LIMIT = 512 * 1024;

/** 大预览 Dialog 中文本类内容的最大字节数（超过继续截断，避免超大日志拖垮渲染）。 */
export const TEXT_DIALOG_LIMIT = 4 * 1024 * 1024;

/** JSON 超过该字节数不再 pretty-print（解析 + 全量格式化开销过大），直接原样高亮。 */
export const JSON_PRETTY_LIMIT = 2 * 1024 * 1024;

/** 超过该字符数不再做语法高亮（hljs 正则开销随体积非线性增长，会冻结主线程数秒），按纯文本渲染。 */
export const HIGHLIGHT_CHAR_LIMIT = 512 * 1024;

/** CSV 内联展示行数（消息流内），Dialog 中放宽到 CSV_DIALOG_ROWS。 */
export const CSV_INLINE_ROWS = 10;
export const CSV_DIALOG_ROWS = 1000;

/** 二进制可预览内容（pdf/video）的最大字节数，超过降级为下载卡片。 */
export const BINARY_PREVIEW_LIMIT = 32 * 1024 * 1024;

/** 扩展名 → content-type。既用于类别判定，也用于修正 Local 后端返回的 octet-stream。 */
export const EXTENSION_MIME_MAP = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  geojson: 'application/json',
  jsonc: 'application/json',
  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  // 交互图表（ECharts option JSON），按 JSON mime 传输
  echarts: 'application/json',
};

/** 代码/文本类扩展名 → highlight.js 语言名（仅覆盖已注册语言，其余按纯文本展示）。 */
const CODE_LANGUAGE_MAP = {
  txt: '',
  log: '',
  env: 'ini',
  ini: 'ini',
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  c: 'cpp',
  h: 'cpp',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'css',
  less: 'css',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  go: 'go',
  golang: 'go',
  java: 'java',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  php: 'php',
  ps1: 'powershell',
  py: 'python',
  pyw: 'python',
  rs: 'rust',
  sql: 'sql',
  xml: 'xml',
  vue: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
};

const CATEGORY_LABELS = {
  image: '图片',
  markdown: 'Markdown',
  code: '代码',
  json: 'JSON',
  csv: '表格',
  chart: '图表',
  pdf: 'PDF',
  html: '网页',
  audio: '音频',
  video: '视频',
  other: '文件',
};

export function getFileExtension(filePath) {
  const name = String(filePath || '').replace(/\\/g, '/').split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  // 无扩展名 / 点号在末尾归为无扩展名；点号开头的 dotfile（.env）取其后缀
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 修正 content-type：服务端（尤其 Local 部署）对部分扩展名回退 octet-stream，
 * 前端按扩展名补全，保证 iframe/audio/video 等原生元素行为正确。
 */
export function correctMimeType(mimeType, filePath) {
  const current = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (current && current !== 'application/octet-stream' && current !== '') return current;
  return EXTENSION_MIME_MAP[getFileExtension(filePath)] || current || 'application/octet-stream';
}

function categoryFromMimeType(mimeType) {
  const type = String(mimeType || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type === 'text/csv') return 'csv';
  if (type === 'text/tab-separated-values') return 'csv';
  if (type === 'application/json' || type === 'application/geo+json' || type.endsWith('+json')) return 'json';
  if (type === 'text/markdown' || type === 'text/x-markdown') return 'markdown';
  if (type.startsWith('text/')) return 'code';
  return '';
}

/**
 * 归类 workspace 文件。
 * @param {string} filePath 文件路径（取扩展名）
 * @param {string} [mimeType] 服务端返回的 content-type（扩展名认不出时兜底）
 * @returns {{ category: string, language: string, label: string, delimiter: string }}
 *   category ∈ image|markdown|code|json|csv|pdf|html|audio|video|other；
 *   language 为 hljs 语言名（仅 code 类有意义）；label 用于卡片展示。
 */
export function categorizeFile(filePath, mimeType = '') {
  const extension = getFileExtension(filePath);
  const baseName = String(filePath || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  const language = Object.prototype.hasOwnProperty.call(CODE_LANGUAGE_MAP, extension)
    ? CODE_LANGUAGE_MAP[extension]
    : undefined;

  let category = '';
  if (extension === 'md' || extension === 'markdown') category = 'markdown';
  else if (extension === 'csv' || extension === 'tsv') category = 'csv';
  // 交互图表两种命名：trend.echarts 或 trend.echarts.json（后者需按 basename 识别，扩展名是 json）
  else if (extension === 'echarts' || baseName.endsWith('.echarts.json')) category = 'chart';
  else if (extension === 'json' || extension === 'geojson' || extension === 'jsonc') category = 'json';
  else if (extension === 'pdf') category = 'pdf';
  else if (extension === 'html' || extension === 'htm') category = 'html';
  else if (language !== undefined) category = 'code';
  else if (EXTENSION_MIME_MAP[extension]) category = categoryFromMimeType(EXTENSION_MIME_MAP[extension]) || 'other';
  else category = categoryFromMimeType(mimeType) || 'other';

  const label = category === 'code'
    ? (language ? `${language} ` : '')
    : '';
  return {
    category,
    language: language || '',
    label: `${label}${CATEGORY_LABELS[category] || '文件'}`.trim(),
    delimiter: extension === 'tsv' ? '\t' : ',',
  };
}
