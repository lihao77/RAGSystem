<template>
  <div class="visualization-loader">
    <div v-if="loading" class="viz-skeleton">
      <div class="skeleton-bar"></div>
      <div class="skeleton-body">
        <div class="skeleton-map-placeholder"></div>
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
import { ref, computed, onMounted } from 'vue';
import ChartRenderer from './ChartRenderer.vue';
import MapRenderer from './MapRenderer.vue';

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
    // 如果是相对路径，转为 API 可访问的路径
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

.viz-skeleton {
  border-radius: 12px;
  padding: 1rem;
  background: var(--msg-bg, #f4f4f5);
}

.skeleton-bar {
  height: 16px;
  width: 40%;
  border-radius: 4px;
  background: var(--skeleton-bg, #e4e4e7);
  margin-bottom: 1rem;
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}

.skeleton-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.skeleton-map-placeholder {
  height: 260px;
  border-radius: 8px;
  background: var(--skeleton-bg, #e4e4e7);
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}

@keyframes skeleton-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

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
