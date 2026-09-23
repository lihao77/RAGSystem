/**
 * Skill 导入导出的压缩包与文件夹适配层。
 *
 * 输入侧把 zip 压缩包 / 本地文件夹归一成后端 bundle 文件数组（根 SKILL.md + 相对路径 + base64）：
 * 剥掉整包多套的一层外层目录、过滤系统垃圾文件与服务端拒绝存储的保留路径，
 * 并从 SKILL.md frontmatter 提取 name/description 供导入直接使用。
 * 输出侧把 bundle 文件数组打包成 zip Blob 下载。jszip 按需动态加载，不进主包。
 *
 * 客户端预校验与后端 validateSkillBundle（skill-bundle.ts）对齐：
 * 路径规则（isValidSkillBundlePath）、大小写不敏感重复、文件与目录冲突、
 * 1–256 个文件、总量 ≤50MB、SKILL.md content 1–30000 字——都在导入时即刻报错，
 * 避免「导入成功、保存才被 422」。
 */

import { base64EncodedSize, decodeBase64Text, encodeBase64Bytes } from './base64.js';
import { guessMediaType, isValidSkillBundlePath } from './skillFiles.js';

const SKILL_MD = 'SKILL.md';
// 操作系统垃圾文件 + 服务端保留目录（skill-bundle.ts validateSkillBundle 拒绝存储）一并过滤，
// 避免导入时看似成功、保存时才被后端拒绝。
const IGNORED_SEGMENTS = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '__macosx', '.git',
  '.venv', 'node_modules', '__pycache__', '.cache', '.installed', '.materialized']);
const MAX_FILES = 256;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
// 流式打包条目的中央目录可能没有解压后大小（占位 0xFFFFFFFF），预检只认可信值。
const UNKNOWN_UNCOMPRESSED_SIZE = 0xffffffff;

export function isIgnoredArchivePath(path) {
  // 按路径段匹配：既命中目录（node_modules/…）也命中以垃圾名结尾的文件（.DS_Store）。
  return String(path || '').replaceAll('\\', '/').toLowerCase().split('/')
    .some((segment) => IGNORED_SEGMENTS.has(segment));
}

/**
 * jszip 默认按 UTF-8 解文件名；Windows「发送到压缩文件夹」等工具产出的 ANSI(GBK) zip
 * 会解出 U+0080–U+00FF 乱码并一路通过前后端校验入库。先严格 UTF-8，失败再按 GBK 兜底。
 */
export function decodeZipFileName(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    try { return new TextDecoder('gbk').decode(bytes); }
    catch { return new TextDecoder('utf-8').decode(bytes); }
  }
}

/** 提取 frontmatter 的 name/description 与正文 content；无 frontmatter 时 content 为整段文本。 */
export function parseSkillFrontmatter(raw) {
  const text = String(raw || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { name: '', description: '', content: text.trim() };
  const fields = { name: '', description: '' };
  for (const line of match[1].split(/\r?\n/)) {
    const entry = line.match(/^(name|description):[ \t]*(.*)$/);
    if (entry) fields[entry[1]] = unquote(entry[2].trim());
  }
  return { ...fields, content: text.slice(match[0].length).replace(/^\r?\n/, '') };
}

/** 解析 zip 压缩包，返回 { name, description, files }；SKILL.md 之外的错误在读取前抛出。 */
export async function readZipBundle(buffer) {
  const { default: JSZip } = await import('jszip');
  let zip;
  try { zip = await JSZip.loadAsync(buffer, { decodeFileName: decodeZipFileName }); }
  catch { throw new Error('无法解析压缩包，请确认是有效的 zip 文件'); }
  const entries = [];
  let declaredBytes = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || isIgnoredArchivePath(entry.name)) continue;
    // 声明的解压后大小在解压前预检，防高压缩比条目（zip 炸弹）撑爆内存。
    const declared = entry._data?.uncompressedSize;
    if (typeof declared === 'number' && declared > 0 && declared < UNKNOWN_UNCOMPRESSED_SIZE) {
      declaredBytes += declared;
      if (declaredBytes > MAX_TOTAL_BYTES) throw new Error('解压后总量超过 50MB 上限');
    }
    entries.push({ path: entry.name.replaceAll('\\', '/'), read: () => entry.async('base64') });
  }
  return collectBundleFiles(entries);
}

/** 读取 input[webkitdirectory] 选中的文件夹，返回 { name, description, files }。 */
export async function readFolderBundle(fileList) {
  const entries = [];
  let totalSize = 0;
  for (const file of [...fileList]) {
    const path = (file.webkitRelativePath || file.name).replaceAll('\\', '/');
    if (isIgnoredArchivePath(path)) continue;
    if (entries.length >= MAX_FILES) throw new Error(`文件数量超过 ${MAX_FILES} 个上限`);
    totalSize += file.size || 0;
    if (totalSize > MAX_TOTAL_BYTES) throw new Error('内容总量超过 50MB 上限');
    entries.push({ path, read: async () => encodeBase64Bytes(new Uint8Array(await file.arrayBuffer())) });
  }
  return collectBundleFiles(entries);
}

export async function createSkillZip(files) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const file of files) zip.file(file.relative_path, file.body_base64, { base64: true });
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** 找到让 SKILL.md 落在根目录的公共前缀：''（已在根）或唯一一层外层目录；找不到返回 null。 */
function commonRootPrefix(paths) {
  if (paths.some((path) => path === SKILL_MD)) return '';
  const first = new Set(paths.map((path) => path.split('/')[0]));
  const [segment] = first;
  if (first.size === 1 && paths.some((path) => path === `${segment}/${SKILL_MD}`)) return `${segment}/`;
  return null;
}

async function collectBundleFiles(entries) {
  if (!entries.length) throw new Error('导入内容为空');
  const prefix = commonRootPrefix(entries.map((entry) => entry.path));
  if (prefix === null) throw new Error('导入内容缺少根 SKILL.md');
  const files = [];
  const seenKeys = new Set();
  let totalBytes = 0;
  for (const entry of entries) {
    const relative = entry.path.slice(prefix.length);
    if (!isValidSkillBundlePath(relative)) throw new Error(`包含无效文件路径：${entry.path}`);
    if (relative.toLowerCase() === 'manifest.json') continue;
    if (files.length >= MAX_FILES) throw new Error(`文件数量超过 ${MAX_FILES} 个上限`);
    const key = relative.toLowerCase();
    if (seenKeys.has(key)) throw new Error(`存在重复文件（不区分大小写）：${relative}`);
    seenKeys.add(key);
    const body_base64 = await entry.read();
    totalBytes += base64EncodedSize(body_base64);
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('内容总量超过 50MB 上限');
    files.push({ relative_path: relative, media_type: guessMediaType(relative), body_base64 });
  }
  for (const key of seenKeys) {
    const parts = key.split('/');
    while (parts.pop() && parts.length) {
      if (seenKeys.has(parts.join('/'))) throw new Error(`文件路径与目录冲突：${key}`);
    }
  }
  files.sort((left, right) => (left.relative_path === SKILL_MD ? -1 : right.relative_path === SKILL_MD ? 1 : left.relative_path.localeCompare(right.relative_path)));
  const markdown = decodeBase64Text(files[0].body_base64);
  const { name, description, content } = parseSkillFrontmatter(markdown);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('SKILL.md frontmatter 缺少有效的 name（小写字母、数字、连字符）');
  const trimmedDescription = description.trim();
  if (!trimmedDescription) throw new Error('SKILL.md frontmatter 缺少 description（保存时必填）');
  if (trimmedDescription.length > 1000) throw new Error('SKILL.md description 超过 1000 字上限');
  // 后端 SkillContentSchema 对正文 trim 后要求 1–30000 字，长文档在这里提前拦截。
  const trimmedContent = content.trim();
  if (!trimmedContent) throw new Error('SKILL.md 正文为空（保存时必填）');
  if (trimmedContent.length > 30000) throw new Error('SKILL.md 正文超过 30000 字上限');
  return { name, description: trimmedDescription, files };
}

function unquote(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return String(JSON.parse(value)); } catch { /* 非法 JSON 串按原样使用 */ }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1);
  return value;
}
