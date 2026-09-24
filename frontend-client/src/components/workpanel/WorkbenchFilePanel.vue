<template>
  <div class="wfp">
    <header class="wfp-head">
      <div class="wfp-head__main">
        <component
          :is="categoryIcon"
          class="wfp-head__icon"
          :style="categoryIconColor ? { color: categoryIconColor } : undefined"
          aria-hidden="true"
        />
        <div class="wfp-head__meta">
          <span class="wfp-head__name" :title="file.name">{{ file.name }}</span>
          <span class="wfp-head__path" :title="file.path">{{ file.path }}</span>
        </div>
      </div>
      <div class="wfp-head__actions">
        <span v-if="sizeText" class="wfp-head__size">{{ sizeText }}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          title="刷新"
          aria-label="刷新文件内容"
          :disabled="loading"
          @click="reload"
        >
          <RefreshCw :class="{ 'animate-spin': loading }" />
        </Button>
        <Button
          v-if="asset"
          variant="ghost"
          size="icon-xs"
          title="下载"
          aria-label="下载文件"
          @click="downloadFile"
        >
          <Download />
        </Button>
      </div>
    </header>

    <div class="wfp-body">
      <div v-if="loading" class="wfp-state">
        <div class="flex w-full flex-col gap-2 px-4 py-6">
          <Skeleton class="h-3.5 w-4/5" />
          <Skeleton class="h-3.5 w-3/5" />
          <Skeleton class="h-3.5 w-2/3" />
        </div>
      </div>

      <div v-else-if="error" class="wfp-state">
        <p class="wfp-state__text is-error">{{ error }}</p>
        <Button variant="outline" size="sm" @click="reload">重试</Button>
      </div>

      <template v-else-if="asset">
        <div v-if="category === 'markdown'" class="wfp-scroll wfp-markdown">
          <MarkdownContent :content="displayText || '（空文件）'" @notify="onNotify" />
          <p v-if="truncated" class="wfp-note">内容较长，仅展示前 512KB</p>
        </div>

        <div v-else-if="isCodeLike" class="wfp-scroll">
          <FileCodeView :text="displayText" :language="codeLanguage" :truncated="truncated" :note="codeNote" @notify="onNotify" />
        </div>

        <div v-else-if="category === 'csv'" class="wfp-scroll">
          <FileCsvTable :text="textState.text" :delimiter="categoryInfo.delimiter" :truncated="truncated" />
        </div>

        <div v-else-if="category === 'image' && objectUrl" class="wfp-image-wrap">
          <img :src="objectUrl" :alt="file.name" class="wfp-image" @click="openImage" />
        </div>

        <div v-else-if="category === 'pdf' && objectUrl" class="wfp-frame">
          <iframe :src="objectUrl" title="PDF 预览" />
        </div>

        <div v-else-if="category === 'html' && objectUrl" class="wfp-frame">
          <iframe :src="objectUrl" sandbox="" :title="file.name" />
        </div>

        <div v-else-if="category === 'audio' && objectUrl" class="wfp-av">
          <audio controls :src="objectUrl" />
        </div>

        <div v-else-if="category === 'video' && objectUrl" class="wfp-av">
          <video controls :src="objectUrl" />
        </div>

        <div v-else class="wfp-state">
          <p class="wfp-state__text">该类型（{{ categoryInfo.label }}）不支持在线预览，请下载后查看。</p>
          <Button variant="outline" size="sm" @click="downloadFile">下载文件</Button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch, watchEffect } from 'vue';
import { Download, RefreshCw } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import MarkdownContent from '@/components/chat/MarkdownContent.vue';
import FileCodeView from '@/components/files/FileCodeView.vue';
import FileCsvTable from '@/components/files/FileCsvTable.vue';
import { useWorkspaceEntryAsset, blobToText } from '@/components/files/useWorkspaceFileAsset.js';
import {
  BINARY_PREVIEW_LIMIT,
  JSON_PRETTY_LIMIT,
  TEXT_PREVIEW_LIMIT,
  categorizeFile,
} from '@/components/files/fileCategorize.js';
import { getFileIcon, getFileIconColor } from '@/components/files/categoryIcons.js';
import { formatSize } from '@/utils/skillFiles.js';
import { useImageLightbox } from '@/composables/useImageLightbox.js';
import { useToast } from '@/composables/useToast.js';

const props = defineProps({
  /** workbenchFiles 登记的文件身份：{ workspaceId, path, name }。 */
  file: { type: Object, required: true },
});

const toast = useToast();
const lightbox = useImageLightbox();

const workspaceIdSource = computed(() => props.file.workspaceId);
const filePathSource = computed(() => props.file.path);
const { loading, error, asset, ensureObjectUrl, reload } = useWorkspaceEntryAsset(workspaceIdSource, filePathSource);

const size = computed(() => asset.value?.size || 0);
const sizeText = computed(() => (size.value ? formatSize(size.value) : ''));
const mimeType = computed(() => asset.value?.mimeType || '');
const categoryInfo = computed(() => categorizeFile(props.file.path, mimeType.value));
const category = computed(() => categoryInfo.value.category);
const categoryIcon = computed(() => getFileIcon(categoryInfo.value));
const categoryIconColor = computed(() => getFileIconColor(categoryInfo.value));

const TEXTUAL_CATEGORIES = ['markdown', 'code', 'json', 'csv', 'chart'];
const isCodeLike = computed(() => ['code', 'json', 'chart'].includes(category.value));
const codeLanguage = computed(() => (category.value === 'json' || category.value === 'chart' ? 'json' : categoryInfo.value.language));
const codeNote = computed(() => (category.value === 'chart' ? '图表文件在工作台按 JSON 展示' : ''));

/* ---- 文本类解码（512KB 截断；图表/JSON 之外原样展示） ---- */
const textState = ref({ text: '', truncated: false });
watch(asset, async (entry) => {
  textState.value = { text: '', truncated: false };
  if (!entry || !TEXTUAL_CATEGORIES.includes(categoryInfo.value.category)) return;
  const decoded = await blobToText(entry.blob, TEXT_PREVIEW_LIMIT);
  if (asset.value === entry) textState.value = decoded;
});

function prettyJsonIfNeeded(raw) {
  if (category.value !== 'json' || size.value > JSON_PRETTY_LIMIT) return raw;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const displayText = computed(() => prettyJsonIfNeeded(textState.value.text));
const truncated = computed(() => textState.value.truncated);

/* ---- 二进制类 objectURL 惰性创建（生命周期归资源层 composable 管） ---- */
const BINARY_VISUAL_CATEGORIES = ['image', 'pdf', 'html', 'audio', 'video'];
const binaryUsable = computed(() => {
  if (!BINARY_VISUAL_CATEGORIES.includes(category.value)) return false;
  if (category.value === 'image') return true;
  if (size.value > BINARY_PREVIEW_LIMIT) return false;
  // 扩展名判成 pdf 但服务端返回其他 content-type 时降级为下载卡片，防伪装成 PDF 的内容
  if (category.value === 'pdf') return mimeType.value === 'application/pdf';
  return true;
});
const objectUrl = ref('');
watchEffect(() => {
  objectUrl.value = binaryUsable.value ? ensureObjectUrl() : '';
});

function openImage() {
  if (objectUrl.value) lightbox.show([{ src: objectUrl.value, alt: props.file.name }]);
}

function downloadFile() {
  const url = ensureObjectUrl();
  if (!url) return;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = props.file.name || props.file.path;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function onNotify(payload) {
  toast.show(payload?.message || '已复制', payload?.type || 'success');
}
</script>

<style scoped>
.wfp {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.wfp-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid var(--color-border);
  padding: 8px 12px;
}

.wfp-head__main {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.wfp-head__icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.wfp-head__meta {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.wfp-head__name {
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium, 500);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wfp-head__path {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wfp-head__actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
}

.wfp-head__size {
  color: var(--color-text-muted);
  font-size: var(--font-size-2xs);
}

.wfp-body {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.wfp-scroll {
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
  scrollbar-width: thin;
}

.wfp-markdown {
  padding: 8px 14px 16px;
}

.wfp-note {
  padding: 6px 2px;
  color: var(--color-text-muted);
  font-size: var(--font-size-2xs);
}

.wfp-image-wrap {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  align-items: flex-start;
  justify-content: center;
  overflow: auto;
  padding: 12px;
  scrollbar-width: thin;
}

.wfp-image {
  max-width: 100%;
  cursor: zoom-in;
}

.wfp-frame {
  min-height: 0;
  flex: 1 1 auto;
}

.wfp-frame iframe {
  width: 100%;
  height: 100%;
  border: none;
}

.wfp-av {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.wfp-av audio,
.wfp-av video {
  width: 100%;
  max-width: 480px;
}

.wfp-state {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px 16px;
}

.wfp-state__text {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  text-align: center;
}

.wfp-state__text.is-error {
  color: var(--color-text-secondary);
}
</style>
