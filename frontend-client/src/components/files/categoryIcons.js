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
