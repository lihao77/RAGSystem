<template>
  <div class="visualization-loader">
    <div v-if="loading" class="viz-skeleton" aria-hidden="true"><div class="skel-shimmer"></div></div>
    <div v-else-if="error" class="viz-error">
      <span class="error-text">{{ error }}</span>
      <Button variant="ghost" size="sm" @click="loadFile">重试</Button>
    </div>
    <template v-else-if="fileUrl">
      <div v-if="showInlineImage" class="fallback-image-wrapper">
        <AuthenticatedImage :src="fileUrl" :alt="fileName" class="fallback-image" loading="lazy" />
        <div class="image-caption">{{ caption || fileName }}</div>
      </div>
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
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { getWorkspaceFileContent, workspaceFileUrl } from '../api/workspaceFile.js';
import AuthenticatedImage from './common/AuthenticatedImage.vue';
import { Button } from './ui/button';

const props = defineProps({
  sessionId: { type: String, required: true },
  filePath: { type: String, required: true },
  presentation: { type: String, default: 'attachment' },
  caption: { type: String, default: '' },
});

const loading = ref(true);
const error = ref('');
const fileSize = ref(0);
const mimeType = ref('application/octet-stream');
const downloading = ref(false);
const fileUrl = computed(() => workspaceFileUrl(props.sessionId, props.filePath));
const fileName = computed(() => String(props.filePath).replace(/\\/g, '/').split('/').pop() || props.filePath);
const isImage = computed(() => /^image\//u.test(mimeType.value));
const showInlineImage = computed(() => isImage.value && props.presentation !== 'attachment');

function formatSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 1024) return `${Math.max(0, Math.round(size || 0))} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadFile() {
  loading.value = true;
  error.value = '';
  try {
    const response = await getWorkspaceFileContent(props.sessionId, props.filePath);
    fileSize.value = Number(response.headers?.['content-length'] || response.data?.size || 0);
    mimeType.value = response.headers?.['content-type']?.split(';')[0] || 'application/octet-stream';
  } catch (cause) {
    error.value = cause?.status === 404 ? '文件不存在或已过期' : (cause?.message || '加载文件失败');
  } finally {
    loading.value = false;
  }
}

async function downloadFile() {
  downloading.value = true;
  try {
    const response = await getWorkspaceFileContent(props.sessionId, props.filePath);
    const objectUrl = URL.createObjectURL(response.data);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName.value;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  } catch (cause) {
    error.value = cause?.message || '文件下载失败';
  } finally {
    downloading.value = false;
  }
}

onMounted(loadFile);
</script>

<style scoped>
.visualization-loader { width: 100%; margin: 0.5rem 0; }
.viz-skeleton { min-height: 96px; border: 1px solid var(--color-border); border-radius: 8px; overflow: hidden; background: var(--color-bg-elevated); position: relative; }
.skel-shimmer { position: absolute; inset: 0; background: linear-gradient(105deg, transparent 30%, rgba(var(--color-interactive-rgb), .06) 50%, transparent 70%); background-size: 250% 100%; animation: skel-shimmer 2.4s ease-in-out infinite; }
@keyframes skel-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.viz-error { display: flex; align-items: center; gap: .5rem; padding: .75rem 1rem; border-radius: 8px; background: var(--color-error-bg); color: var(--color-error); font-size: .875rem; }
.error-text { flex: 1; }
.fallback-image-wrapper { text-align: center; }
.fallback-image { margin: 0 auto; max-width: 100%; border-radius: 8px; }
.image-caption { margin-top: .5rem; color: var(--color-text-secondary); font-size: .875rem; }
.workspace-file-card { display: flex; align-items: center; gap: 1rem; padding: 1rem; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-elevated); }
.workspace-file-copy { min-width: 0; flex: 1; }
.workspace-file-title { overflow: hidden; color: var(--color-text-primary); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.workspace-file-meta { margin-top: .25rem; color: var(--color-text-secondary); font-size: .8125rem; }
</style>
