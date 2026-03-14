<template>
  <div class="visualization-loader">
    <div v-if="loading" class="viz-skeleton">
      <div class="skeleton-bar"></div>
      <div class="skeleton-body">
        <div class="skeleton-line" v-for="n in 4" :key="n"></div>
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
      />
      <div v-else-if="vizData.viz_type === 'image'" class="fallback-image-wrapper">
        <img :src="imageUrl" :alt="vizData.title" class="fallback-image" />
        <div class="image-caption" v-if="vizData.title">{{ vizData.title }}</div>
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

const loading = ref(true);
const error = ref(null);
const vizData = ref(null);

const imageUrl = computed(() => {
  if (!vizData.value) return '';
  if (vizData.value.viz_type === 'image') {
    const path = vizData.value.image_url || '';
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
  try {
    const resp = await fetch(`/api/artifacts/visualizations/${encodeURIComponent(props.artifactId)}`);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    vizData.value = await resp.json();
  } catch (e) {
    error.value = `加载可视化失败: ${e.message}`;
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

.skeleton-line {
  height: 12px;
  border-radius: 4px;
  background: var(--skeleton-bg, #e4e4e7);
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}

.skeleton-line:nth-child(1) { width: 90%; }
.skeleton-line:nth-child(2) { width: 75%; }
.skeleton-line:nth-child(3) { width: 85%; }
.skeleton-line:nth-child(4) { width: 60%; }

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
  color: white;
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
