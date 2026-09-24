/**
 * 展示类别 → lucide 图标映射，供预览卡片与 Dialog 标题复用。
 */
import {
  ChartLine,
  File as FileIcon,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileType,
  Globe,
  Music,
  Video,
} from 'lucide-vue-next';

const CATEGORY_ICONS = {
  image: FileImage,
  markdown: FileText,
  code: FileCode,
  json: FileJson,
  csv: FileSpreadsheet,
  chart: ChartLine,
  pdf: FileType,
  html: Globe,
  audio: Music,
  video: Video,
  other: FileIcon,
};

export function getCategoryIcon(category) {
  return CATEGORY_ICONS[category] || FileIcon;
}

/**
 * 类别 → 图标着色。语义近似的类别复用主题 token（随明暗主题走），
 * 其余取双主题均可读的中饱和色值；other 不着色，维持默认 muted。
 */
const CATEGORY_ICON_COLORS = {
  code: '#4d9fff',
  json: 'var(--color-warning)',
  csv: 'var(--color-success)',
  chart: '#2fb3a6',
  markdown: '#7f8fea',
  image: '#c678dd',
  pdf: 'var(--color-error)',
  html: '#e07b53',
  audio: '#d16d85',
  video: '#e06c75',
};

export function getCategoryIconColor(category) {
  return CATEGORY_ICON_COLORS[category] || null;
}

/**
 * 按归类结果取图标：code 类里没有语言名的（txt/log 等纯文本）按普通文本文件展示，
 * 不再与 .py/.ts 等真代码共用 FileCode；颜色同理，纯文本不着色。
 */
export function getFileIcon(info) {
  if (info?.category === 'code' && !info.language) return FileText;
  return getCategoryIcon(info?.category);
}

export function getFileIconColor(info) {
  if (info?.category === 'code' && !info.language) return null;
  return getCategoryIconColor(info?.category);
}
