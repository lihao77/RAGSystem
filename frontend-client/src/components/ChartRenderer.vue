<template>
  <div class="chart-renderer">
    <div class="chart-header">
      <div class="chart-title">
        <span class="chart-icon">📊</span>
        <span>{{ title }}</span>
      </div>
      <div class="chart-actions">
        <button @click="toggleFullscreen" class="action-btn" title="全屏">
          <span v-if="!isFullscreen">⛶</span>
          <span v-else>⛶</span>
        </button>
        <button @click="downloadChart" class="action-btn" title="下载图表">
          💾
        </button>
      </div>
    </div>
    <div
      ref="chartContainer"
      class="chart-container"
      :class="{ 'fullscreen': isFullscreen }"
    ></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  echartsConfig: {
    type: Object,
    required: true
  },
  title: {
    type: String,
    default: '数据可视化'
  },
  chartType: {
    type: String,
    default: 'bar'
  }
});

const chartContainer = ref(null);
const chartInstance = ref(null);
const isFullscreen = ref(false);

// 初始化图表
const initChart = () => {
  if (!chartContainer.value) return;

  // 销毁旧实例
  if (chartInstance.value) {
    chartInstance.value.dispose();
  }

  // 创建新实例
  chartInstance.value = echarts.init(chartContainer.value);

  // 设置配置
  chartInstance.value.setOption(props.echartsConfig);

  // 添加响应式
  window.addEventListener('resize', handleResize);
};

// 响应式调整大小
const handleResize = () => {
  if (chartInstance.value) {
    chartInstance.value.resize();
  }
};

// 切换全屏
const toggleFullscreen = () => {
  isFullscreen.value = !isFullscreen.value;
  // 等待DOM更新后调整大小
  setTimeout(() => {
    handleResize();
  }, 100);
};

// 下载图表
const downloadChart = () => {
  if (!chartInstance.value) return;

  const url = chartInstance.value.getDataURL({
    type: 'png',
    pixelRatio: 2,
    backgroundColor: '#fff'
  });

  const link = document.createElement('a');
  link.download = `${props.title || 'chart'}_${Date.now()}.png`;
  link.href = url;
  link.click();
};

// 监听配置变化
watch(() => props.echartsConfig, (newConfig) => {
  if (chartInstance.value && newConfig) {
    chartInstance.value.setOption(newConfig, true);
  }
}, { deep: true });

onMounted(() => {
  initChart();
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  if (chartInstance.value) {
    chartInstance.value.dispose();
  }
});
</script>

<style scoped>
.chart-renderer {
  margin: 16px 0;
  border: var(--glass-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: rgba(255, 255, 255, 0.45);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  animation: fadeInUp 0.5s ease;
  box-shadow: var(--glass-shadow);
  transition: all 0.3s ease;
}

.chart-renderer:hover {
  background: rgba(255, 255, 255, 0.55);
  box-shadow: 0 12px 40px 0 rgba(31, 38, 135, 0.1);
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.3);
  border-bottom: 1px solid rgba(255, 255, 255, 0.2);
}

.chart-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-main);
  text-shadow: 0 1px 1px rgba(255, 255, 255, 0.5);
}

.chart-icon {
  font-size: 16px;
}

.chart-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  background: rgba(255, 255, 255, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.3);
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s ease;
  color: var(--color-text-secondary);
}

.action-btn:hover {
  background: rgba(255, 255, 255, 0.6);
  border-color: rgba(255, 255, 255, 0.5);
  color: var(--color-text-main);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.chart-container {
  width: 100%;
  height: 400px;
  padding: 16px;
  transition: all 0.3s ease;
  background: transparent;
}

.chart-container.fullscreen {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 9999;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  padding: 40px;
}
</style>