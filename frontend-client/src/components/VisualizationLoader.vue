<template>
  <div class="visualization-loader">
    <div v-if="loading" class="viz-skeleton" aria-hidden="true"><div class="skel-shimmer"></div></div>
    <div v-else-if="error" class="viz-error">
      <span class="error-text">{{ error }}</span>
      <Button variant="ghost" size="sm" @click="reload">重试</Button>
    </div>
    <template v-else-if="asset">

      <!-- 图片：inline 全尺寸内联 / preview 限高缩略图，点击进 lightbox -->
      <div v-if="renderMode === 'image'" class="fallback-image-wrapper" :class="{ 'fallback-image-wrapper--thumb': isPreviewPresentation }">
        <AuthenticatedImage
          :src="objectUrl"
          :alt="caption || fileName"
          class="fallback-image"
          :class="{ 'fallback-image--thumb': isPreviewPresentation }"
          loading="lazy"
          role="button"
          @click="openImage"
        />
        <div v-if="caption || fileName" class="image-caption">{{ caption || fileName }}</div>
      </div>

      <!-- 文本/二进制内容 inline：统一外壳（标题栏 + 限高内容 + 操作） -->
      <div v-else-if="renderMode === 'inline'" class="file-inline-shell">
        <div class="file-inline-shell__head">
          <component :is="categoryIcon" :size="14" class="file-inline-shell__icon" />
          <span class="file-inline-shell__title" :title="caption || fileName">{{ caption || fileName }}</span>
          <span class="file-inline-shell__meta">{{ categoryInfo.label }} · {{ formatSize(fileSize) }}</span>
          <div class="file-inline-shell__actions">
            <Button variant="ghost" size="sm" @click="openDialog">
              <Maximize2 :size="14" />
              放大
            </Button>
            <Button variant="ghost" size="sm" :disabled="downloading" @click="downloadFile">
              <Download :size="14" />
              {{ downloading ? '下载中…' : '下载' }}
            </Button>
          </div>
        </div>

        <div class="file-inline-shell__body">
          <div v-if="categoryInfo.category === 'markdown'" class="file-inline-shell__scroll">
            <MarkdownContent :content="displayText || '（空文件）'" @notify="payload => emit('notify', payload)" />
          </div>
          <FileCodeView
            v-else-if="categoryInfo.category === 'code' || categoryInfo.category === 'json'"
            :text="displayText"
            :language="categoryInfo.category === 'json' ? 'json' : categoryInfo.language"
            :truncated="textState.truncated"
            :max-height="420"
            @notify="payload => emit('notify', payload)"
          />
          <FileCsvTable
            v-else-if="categoryInfo.category === 'csv'"
            :text="displayText"
            :delimiter="categoryInfo.delimiter"
            :max-rows="CSV_INLINE_ROWS"
            :truncated="textState.truncated"
            :max-height="360"
          />
          <div v-else-if="categoryInfo.category === 'pdf' && objectUrl" class="file-inline-shell__frame">
            <iframe :src="objectUrl" :title="caption || fileName" />
          </div>
          <div v-else-if="categoryInfo.category === 'html' && objectUrl" class="file-inline-shell__frame">
            <iframe :src="objectUrl" sandbox="" :title="caption || fileName" />
          </div>
          <div v-else-if="categoryInfo.category === 'audio' && objectUrl" class="file-inline-shell__audio">
            <audio controls :src="objectUrl" />
          </div>
          <div v-else-if="categoryInfo.category === 'video' && objectUrl" class="file-inline-shell__video">
            <video controls :src="objectUrl" />
          </div>
        </div>

        <div v-if="inlineNote" class="file-inline-shell__note" role="note">{{ inlineNote }}</div>
      </div>

      <!-- preview 卡片（文档/媒体类）：紧凑卡片，点击打开大预览 -->
      <button
        v-else-if="renderMode === 'preview-card'"
        type="button"
        class="workspace-file-card workspace-file-card--clickable"
        :title="`预览 ${fileName}`"
        @click="openDialog"
      >
        <component :is="categoryIcon" :size="20" class="workspace-file-icon" />
        <div class="workspace-file-copy">
          <div class="workspace-file-title">{{ caption || fileName }}</div>
          <div class="workspace-file-meta">{{ categoryInfo.label }} · {{ mimeType }} · {{ formatSize(fileSize) }}</div>
        </div>
        <span class="workspace-file-preview-hint"><Eye :size="14" /> 预览</span>
      </button>

      <!-- attachment / 不可预览类别 / 超限：下载卡片 -->
      <div v-else class="workspace-file-card">
        <div class="workspace-file-copy">
          <div class="workspace-file-title">{{ fileName }}</div>
          <div class="workspace-file-meta">{{ mimeType }} · {{ formatSize(fileSize) }}</div>
        </div>
        <Button variant="outline" size="sm" :disabled="downloading" @click="downloadFile">
          {{ downloading ? '下载中…' : '下载文件' }}
        </Button>
      </div>
    </template>

    <ImageLightbox
      :open="lightbox.open.value"
      :images="lightbox.images.value"
      :index="lightbox.index.value"
      :current="lightbox.current.value"
      @close="lightbox.close"
      @previous="lightbox.previous"
      @next="lightbox.next"
    />
    <FilePreviewDialog
      v-model:open="dialogOpen"
      :title="caption || fileName"
      :file-name="fileName"
      :meta="`${categoryInfo.label} · ${mimeType} · ${formatSize(fileSize)}`"
      :category="categoryInfo.category"
      :language="categoryInfo.language"
      :delimiter="categoryInfo.delimiter"
      :text="dialogDisplayText"
      :truncated="dialogTextState.truncated"
      :object-url="objectUrl"
      :downloading="downloading"
      @download="downloadFile"
      @notify="payload => emit('notify', payload)"
    />
  </div>
</template>

<script setup>
import { computed, ref, watch, watchEffect } from 'vue';
import AuthenticatedImage from './common/AuthenticatedImage.vue';
import ImageLightbox from './common/ImageLightbox.vue';
import MarkdownContent from './chat/MarkdownContent.vue';
import { Button } from './ui/button';
import { Download, Eye, Maximize2 } from 'lucide-vue-next';
import { useImageLightbox } from '../composables/useImageLightbox.js';
import FileCodeView from './files/FileCodeView.vue';
import FileCsvTable from './files/FileCsvTable.vue';
import FilePreviewDialog from './files/FilePreviewDialog.vue';
import { getCategoryIcon } from './files/categoryIcons.js';
import {
  BINARY_PREVIEW_LIMIT,
  CSV_INLINE_ROWS,
  JSON_PRETTY_LIMIT,
  TEXT_DIALOG_LIMIT,
  TEXT_PREVIEW_LIMIT,
  categorizeFile,
} from './files/fileCategorize.js';
import { blobToText, useWorkspaceFileAsset } from './files/useWorkspaceFileAsset.js';

const props = defineProps({
  sessionId: { type: String, required: true },
  filePath: { type: String, required: true },
  presentation: { type: String, default: 'attachment' },
  caption: { type: String, default: '' },
});

const emit = defineEmits(['notify']);

const { loading, error, asset, ensureObjectUrl, reload } = useWorkspaceFileAsset(
  () => props.sessionId,
  () => props.filePath,
);

const downloading = ref(false);
const dialogOpen = ref(false);
const lightbox = useImageLightbox();

const fileName = computed(() => String(props.filePath).replace(/\\/g, '/').split('/').pop() || props.filePath);
const fileSize = computed(() => asset.value?.size || 0);
const mimeType = computed(() => asset.value?.mimeType || '');
const categoryInfo = computed(() => categorizeFile(props.filePath, mimeType.value));
const categoryIcon = computed(() => getCategoryIcon(categoryInfo.value.category));
const isPreviewPresentation = computed(() => props.presentation === 'preview');

const TEXTUAL_CATEGORIES = ['markdown', 'code', 'json', 'csv'];
const BINARY_CATEGORIES = ['pdf', 'html', 'audio', 'video'];

const binaryWithinLimit = computed(() => BINARY_CATEGORIES.includes(categoryInfo.value.category)
  && fileSize.value <= BINARY_PREVIEW_LIMIT
  // PDF iframe 未加 sandbox（沙箱内 PDF 查看器不可用），blob URL 继承应用 origin；
  // 扩展名判成 pdf 但服务端返回其他 content-type 时降级为下载卡片，防伪装成 PDF 的 HTML 执行脚本。
  // （html 分支始终走 sandbox="" iframe，无需同样校验）
  && (categoryInfo.value.category !== 'pdf' || mimeType.value === 'application/pdf'));

/**
 * presentation × category → 渲染模式：
 *   image        图片（inline 全尺寸 / preview 缩略图），点击 lightbox
 *   inline       内容直接嵌入消息流（外壳 + 限高滚动）
 *   preview-card 紧凑卡片，点击打开 FilePreviewDialog
 *   card         下载卡片（attachment / 不支持类别 / 超限降级）
 */
const renderMode = computed(() => {
  if (!asset.value) return 'card';
  const { category } = categoryInfo.value;
  if (category === 'image') return props.presentation === 'attachment' ? 'card' : 'image';
  if (props.presentation === 'attachment') return 'card';
  if (category === 'audio') return binaryWithinLimit.value ? 'inline' : 'card';
  if (TEXTUAL_CATEGORIES.includes(category)) return isPreviewPresentation.value ? 'preview-card' : 'inline';
  if (binaryWithinLimit.value) return isPreviewPresentation.value ? 'preview-card' : 'inline';
  return 'card';
});

/* ---- 文本类内容解码（inline 用 512KB 截断，Dialog 放宽到 4MB） ---- */
const textState = ref({ text: '', truncated: false });
const dialogTextState = ref({ text: '', truncated: false });

watch(asset, async (entry) => {
  textState.value = { text: '', truncated: false };
  if (!entry || !TEXTUAL_CATEGORIES.includes(categoryInfo.value.category)) return;
  const decoded = await blobToText(entry.blob, TEXT_PREVIEW_LIMIT);
  if (asset.value === entry) textState.value = decoded;
});

watch([asset, dialogOpen], async ([entry, open]) => {
  if (!open || !entry || !TEXTUAL_CATEGORIES.includes(categoryInfo.value.category)) return;
  const decoded = await blobToText(entry.blob, TEXT_DIALOG_LIMIT);
  if (asset.value === entry && dialogOpen.value) dialogTextState.value = decoded;
});

/** JSON 在合理体积内 pretty-print 后再高亮，其余原样。 */
function prettyJsonIfNeeded(raw) {
  if (categoryInfo.value.category !== 'json' || fileSize.value > JSON_PRETTY_LIMIT) return raw;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const displayText = computed(() => prettyJsonIfNeeded(textState.value.text));
const dialogDisplayText = computed(() => prettyJsonIfNeeded(dialogTextState.value.text));
const inlineNote = computed(() => {
  if (!textState.value.truncated) return '';
  return categoryInfo.value.category === 'markdown'
    ? '内容较长，内联仅展示前 512KB，可点击"放大"查看'
    : '';
});

/* ---- blob objectURL 惰性创建：图片（含 lightbox）与二进制类共用，复用缓存避免二次下载 ---- */
const objectUrl = ref('');
watchEffect(() => {
  const needed = Boolean(asset.value)
    && (renderMode.value === 'image'
      || (BINARY_CATEGORIES.includes(categoryInfo.value.category)
        && (renderMode.value === 'inline' || dialogOpen.value)));
  objectUrl.value = needed ? ensureObjectUrl() : '';
});

function openImage() {
  if (!objectUrl.value) return;
  lightbox.show([{ src: objectUrl.value, alt: props.caption || fileName.value }]);
}

function openDialog() {
  dialogOpen.value = true;
}

async function downloadFile() {
  if (!asset.value) return;
  downloading.value = true;
  try {
    const objectUrlForDownload = URL.createObjectURL(asset.value.blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrlForDownload;
    anchor.download = fileName.value;
    anchor.click();
    URL.revokeObjectURL(objectUrlForDownload);
  } catch (cause) {
    // 下载失败只提示，不写入 error：asset 本身加载正常，不应把整个预览切到"加载失败"
    emit('notify', { message: cause?.message || '文件下载失败', type: 'error' });
  } finally {
    downloading.value = false;
  }
}

function formatSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 1024) return `${Math.max(0, Math.round(size || 0))} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<style scoped>
.visualization-loader { width: 100%; margin: 0.5rem 0; }
.viz-skeleton { min-height: 96px; border: 1px solid var(--color-border); border-radius: 8px; overflow: hidden; background: var(--color-bg-elevated); position: relative; }
.skel-shimmer { position: absolute; inset: 0; background: linear-gradient(105deg, transparent 30%, rgba(var(--color-interactive-rgb), .06) 50%, transparent 70%); background-size: 250% 100%; animation: skel-shimmer 2.4s ease-in-out infinite; }
@keyframes skel-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.viz-error { display: flex; align-items: center; gap: .5rem; padding: .75rem 1rem; border-radius: 8px; background: var(--color-error-bg); color: var(--color-error); font-size: .875rem; }
.error-text { flex: 1; }

/* 图片 */
.fallback-image-wrapper { text-align: center; }
.fallback-image { margin: 0 auto; max-width: 100%; border-radius: 8px; cursor: zoom-in; }
.fallback-image--thumb { max-height: 240px; width: auto; }
.image-caption { margin-top: .5rem; color: var(--color-text-secondary); font-size: .875rem; }

/* 下载卡片（attachment / 降级） */
.workspace-file-card { display: flex; align-items: center; gap: 1rem; padding: 1rem; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-elevated); width: 100%; text-align: left; }
.workspace-file-copy { min-width: 0; flex: 1; }
.workspace-file-title { overflow: hidden; color: var(--color-text-primary); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.workspace-file-meta { margin-top: .25rem; color: var(--color-text-secondary); font-size: .8125rem; }

/* preview 卡片 */
.workspace-file-card--clickable { cursor: pointer; transition: border-color .18s ease, background .18s ease; }
.workspace-file-card--clickable:hover { border-color: var(--color-border-hover, var(--color-border)); background: var(--color-hover-overlay); }
.workspace-file-icon { color: var(--color-text-secondary); flex-shrink: 0; }
.workspace-file-preview-hint { display: inline-flex; align-items: center; gap: 4px; color: var(--color-text-secondary); font-size: .75rem; flex-shrink: 0; }

/* inline 内容外壳 */
.file-inline-shell { border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-elevated); overflow: hidden; }
.file-inline-shell__head { display: flex; align-items: center; gap: .5rem; min-height: 40px; padding: 0 .5rem 0 .75rem; border-bottom: 1px solid var(--color-border); background: rgba(var(--color-bg-elevated-rgb), .24); }
.file-inline-shell__icon { color: var(--color-text-secondary); flex-shrink: 0; }
.file-inline-shell__title { overflow: hidden; color: var(--color-text-primary); font-weight: 600; font-size: .8125rem; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.file-inline-shell__meta { color: var(--color-text-secondary); font-size: .75rem; white-space: nowrap; flex-shrink: 0; }
.file-inline-shell__actions { display: flex; gap: .25rem; margin-left: auto; flex-shrink: 0; }
.file-inline-shell__body { min-width: 0; }
.file-inline-shell__scroll { max-height: 480px; overflow-y: auto; padding: .25rem .875rem; scrollbar-width: thin; }
.file-inline-shell__frame { height: 480px; background: var(--color-bg-secondary); }
.file-inline-shell__frame iframe { width: 100%; height: 100%; border: 0; }
.file-inline-shell__audio { padding: .75rem; }
.file-inline-shell__audio audio { width: 100%; }
.file-inline-shell__video { display: flex; justify-content: center; padding: .75rem; background: var(--color-bg-secondary); }
.file-inline-shell__video video { max-height: 420px; max-width: 100%; border-radius: 8px; }
.file-inline-shell__note { padding: .375rem .875rem; border-top: 1px dashed var(--color-border); color: var(--color-text-secondary); font-size: .75rem; }
</style>
