<template>
  <div class="visualization-loader">
    <!-- 骨架屏：结构与 Artifact 图表和文件展示区域对齐 -->
    <div v-if="loading" class="viz-skeleton">
      <div class="skel-header">
        <span class="skel-icon"></span>
        <span class="skel-title"></span>
        <span class="skel-actions">
          <span class="skel-btn"></span>
          <span class="skel-btn"></span>
        </span>
      </div>
      <div class="skel-body">
        <div class="skel-shimmer"></div>
      </div>
    </div>

    <div v-else-if="error" class="viz-error">
      <span class="error-icon">
        <IconInfo :size="18" />
      </span>
      <span class="error-text">{{ error }}</span>
      <Button class="retry-btn" variant="ghost" size="sm" @click="fetchConfig">重试</Button>
    </div>

    <template v-else>
      <ChartRenderer
        v-if="vizData.displayKind === 'chart'"
        :echartsConfig="vizData.config"
        :title="vizData.title"
        :chartType="vizData.subtype"
      />
      <div v-else-if="isImage" class="fallback-image-wrapper">
        <AuthenticatedImage
          :src="imageUrl"
          :alt="vizData.title"
          class="fallback-image"
          loading="lazy"
          @error="imageError = true"
        />
        <div v-if="imageError" class="viz-error" style="margin-top: 0.5rem;">
          <span class="error-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="9" y1="15" x2="15" y2="9"></line>
            </svg>
          </span>
          <span class="error-text">图片加载失败</span>
        </div>
        <div class="image-caption" v-if="vizData.title && !imageError">{{ vizData.title }}</div>
      </div>
      <div v-else-if="vizData.content_url" class="artifact-file-card">
        <div class="artifact-file-copy">
          <div class="artifact-file-title">{{ artifactFilename }}</div>
          <div class="artifact-file-meta">{{ artifactTypeLabel }}</div>
          <div v-if="downloadError" class="artifact-file-error">{{ downloadError }}</div>
        </div>
        <Button variant="outline" size="sm" :disabled="downloading" @click="downloadArtifact">
          {{ downloading ? '下载中…' : '下载文件' }}
        </Button>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, defineAsyncComponent, onMounted } from 'vue';
import { getArtifact, getArtifactAssetContent } from '../api/artifact.js';
import { normalizeArtifactManifest } from '../utils/artifact.js';
import IconInfo from './icons/IconInfo.vue';
import AuthenticatedImage from './common/AuthenticatedImage.vue';
import { Button } from './ui/button';

const ChartRenderer = defineAsyncComponent(() => import('./ChartRenderer.vue'));

const props = defineProps({
  artifactId: {
    type: String,
    required: true,
  },
});

const loading = ref(true);
const error = ref(null);
const vizData = ref(null);
const imageError = ref(false);
const downloading = ref(false);
const downloadError = ref('');
const isImage = computed(() => vizData.value?.displayKind === 'image');
const artifactFilename = computed(() => vizData.value?.asset?.filename || vizData.value?.title || props.artifactId);
const artifactTypeLabel = computed(() => {
  const mimeType = vizData.value?.mime_type || vizData.value?.asset?.mime_type || 'application/octet-stream';
  return `${mimeType} · ${vizData.value?.kind || 'generic'}`;
});

const imageUrl = computed(() => {
  if (!vizData.value) return '';
  return isImage.value && typeof vizData.value.content_url === 'string' ? vizData.value.content_url : '';
});

async function fetchConfig() {
  loading.value = true;
  error.value = null;
  imageError.value = false;
  downloadError.value = '';
  try {
    let data;
    try {
      data = await getArtifact(props.artifactId);
    } catch (error) {
      if (error.status === 404) throw new Error('产物不存在或已过期');
      if (error.status >= 500) throw new Error('服务器暂时不可用，请稍后重试');
      throw new Error(error.message || '请求失败');
    }
    vizData.value = normalizeArtifactManifest(data);
  } catch (e) {
    error.value = e.message.startsWith('产物') || e.message.startsWith('服务器') || e.message.startsWith('请求失败')
      ? e.message
      : '加载产物失败，请检查网络连接';
  } finally {
    loading.value = false;
  }
}

async function downloadArtifact() {
  downloading.value = true;
  downloadError.value = '';
  try {
    const assetId = vizData.value?.primaryAsset?.asset_id;
    if (!assetId) throw new Error('该 Artifact 没有可下载的 Asset');
    const response = await getArtifactAssetContent(props.artifactId, assetId);
    const objectUrl = URL.createObjectURL(response.data);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = artifactFilename.value;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (e) {
    downloadError.value = e?.message || '文件下载失败';
  } finally {
    downloading.value = false;
  }
}

onMounted(fetchConfig);
</script>

<style scoped>
.visualization-loader {
  width: 100%;
  margin: 0.5rem 0;
}

/* ===== 骨架屏：结构对齐 Artifact 展示区域 ===== */

.viz-skeleton {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 12px);
  overflow: hidden;
  background: var(--glass-bg-light);
}

/* 头部：与 Artifact 展示标题栏同高、同结构 */
.skel-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
  padding: var(--spacing-md, 16px);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}

.skel-icon {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  background: var(--color-bg-tertiary);
  flex-shrink: 0;
  opacity: 0.6;
}

.skel-title {
  height: 14px;
  width: 30%;
  min-width: 80px;
  border-radius: 4px;
  background: var(--color-bg-tertiary);
  opacity: 0.6;
}

.skel-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.skel-btn {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md, 10px);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
}

/* 内容区：尺寸匹配实际 Artifact 展示区域 */
.skel-body {
  aspect-ratio: 16 / 9;
  min-height: 300px;
  max-height: 500px;
  background: var(--color-bg-primary);
  position: relative;
  overflow: hidden;
}

/* 微光扫过动效 */
.skel-shimmer {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    105deg,
    transparent 30%,
    rgba(var(--color-interactive-rgb), 0.035) 45%,
    rgba(var(--color-interactive-rgb), 0.07) 50%,
    rgba(var(--color-interactive-rgb), 0.035) 55%,
    transparent 70%
  );
  background-size: 250% 100%;
  animation: skel-shimmer 2.4s ease-in-out infinite;
}

@keyframes skel-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* 响应式：匹配 Artifact 内容的移动端收缩 */
@media (max-width: 767px) {
  .skel-body {
    aspect-ratio: 4 / 3;
    min-height: 250px;
    max-height: 350px;
  }

  .skel-header {
    padding: var(--spacing-sm, 8px) var(--spacing-md, 16px);
  }
}

/* ===== 错误状态 ===== */

.viz-error {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  background: var(--color-error-bg);
  color: var(--color-error);
  font-size: 0.875rem;
}

.error-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.error-text {
  flex: 1;
}

.retry-btn {
  flex-shrink: 0;
  padding: 0.25rem 0.75rem;
  border: 1px solid currentColor;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 0.8125rem;
  transition: background 0.15s;
}

.retry-btn:hover {
  background: var(--color-error-bg);
}

/* ===== 图片回退 ===== */

.fallback-image-wrapper {
  text-align: center;
}

.fallback-image {
  margin: 0 auto;
  max-width: 100%;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.image-caption {
  margin-top: 0.5rem;
  font-size: 0.875rem;
  color: var(--color-text-secondary);
}

.artifact-file-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 12px);
  background: var(--color-bg-elevated);
}

.artifact-file-copy {
  min-width: 0;
  flex: 1;
}

.artifact-file-title {
  overflow: hidden;
  color: var(--color-text-primary);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-file-meta {
  margin-top: 0.25rem;
  color: var(--color-text-secondary);
  font-size: 0.8125rem;
}

.artifact-file-error {
  margin-top: 0.4rem;
  color: var(--color-error);
  font-size: 0.8125rem;
}
</style>
