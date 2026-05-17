<template>
  <div class="visualization-loader">
    <!-- 骨架屏：结构与实际渲染器 (chart-renderer / map-renderer) 对齐 -->
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
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
      </span>
      <span class="error-text">{{ error }}</span>
      <button @click="fetchConfig" class="retry-btn">重试</button>
    </div>

    <template v-else>
      <ChartRenderer
        v-if="vizData.viz_type === 'chart'"
        :echartsConfig="vizData.config"
        :title="vizData.title"
        :chartType="vizData.sub_type"
      />
      <MapRenderer
        v-else-if="vizData.viz_type === 'map'"
        :mapData="vizData.config"
        :title="vizData.title"
        @enter-situation="$emit('enter-situation', { artifactId: props.artifactId, mapData: vizData.config, vizData })"
      />
      <div v-else-if="vizData.viz_type === 'image'" class="fallback-image-wrapper">
        <img
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
    </template>
  </div>
</template>

<script setup>
import { ref, computed, defineAsyncComponent, onMounted } from 'vue';

const ChartRenderer = defineAsyncComponent(() => import('./ChartRenderer.vue'));
const MapRenderer = defineAsyncComponent(() => import('./MapRenderer.vue'));

const props = defineProps({
  artifactId: {
    type: String,
    required: true,
  },
});

defineEmits(['enter-situation']);

const loading = ref(true);
const error = ref(null);
const vizData = ref(null);
const imageError = ref(false);

const imageUrl = computed(() => {
  if (!vizData.value) return '';
  if (vizData.value.viz_type === 'image') {
    const raw = vizData.value.image_url;
    const path = typeof raw === 'string' ? raw : '';
    if (path.startsWith('./static/')) {
      return '/' + path.replace('./', '');
    }
    return path;
  }
  return '';
});

async function fetchConfig() {
  loading.value = true;
  error.value = null;
  imageError.value = false;
  try {
    const resp = await fetch(`/api/artifacts/visualizations/${encodeURIComponent(props.artifactId)}`);
    if (!resp.ok) {
      if (resp.status === 404) throw new Error('可视化内容不存在或已过期');
      if (resp.status >= 500) throw new Error('服务器暂时不可用，请稍后重试');
      throw new Error(`请求失败 (${resp.status})`);
    }
    const data = await resp.json();
    if (!data || typeof data !== 'object' || !data.viz_type) {
      throw new Error('可视化数据结构异常：缺少 viz_type 字段');
    }
    if (!['chart', 'map', 'image'].includes(data.viz_type)) {
      throw new Error(`不支持的可视化类型: ${data.viz_type}`);
    }
    if ((data.viz_type === 'chart' || data.viz_type === 'map') && !data.config) {
      throw new Error(`可视化数据结构异常：${data.viz_type} 类型缺少 config 字段`);
    }
    vizData.value = data;
  } catch (e) {
    error.value = e.message.startsWith('可视化') || e.message.startsWith('服务器') || e.message.startsWith('请求失败')
      ? e.message
      : '加载可视化失败，请检查网络连接';
  } finally {
    loading.value = false;
  }
}

onMounted(fetchConfig);
</script>

<style scoped>
.visualization-loader {
  width: 100%;
  margin: 0.5rem 0;
}

/* ===== 骨架屏：结构对齐 chart-renderer / map-renderer ===== */

.viz-skeleton {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 12px);
  overflow: hidden;
  background: var(--glass-bg-light);
}

/* 头部：与 chart-header / map-header 同高、同结构 */
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

/* 内容区：尺寸匹配实际渲染器的 chart-container / map-container */
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

/* 响应式：匹配 ChartRenderer / MapRenderer 的移动端收缩 */
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
  background: var(--error-bg, #fef2f2);
  color: var(--error-color, #dc2626);
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
  background: var(--error-color, #dc2626);
  color: var(--color-on-color);
}

/* ===== 图片回退 ===== */

.fallback-image-wrapper {
  text-align: center;
}

.fallback-image {
  max-width: 100%;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.image-caption {
  margin-top: 0.5rem;
  font-size: 0.875rem;
  color: var(--text-secondary, #71717a);
}
</style>
