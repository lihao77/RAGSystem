<template>
  <div class="chart-renderer">
    <div class="chart-header">
      <div class="chart-title">
        <span class="chart-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="18" y="13" width="4" height="9" rx="1"></rect>
            <rect x="12" y="7" width="4" height="15" rx="1"></rect>
            <rect x="6" y="15" width="4" height="7" rx="1"></rect>
          </svg>
        </span>
        <span>{{ title }}</span>
      </div>
      <div class="chart-actions">
        <button @click="downloadChart" class="action-btn" title="下载图表">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
        <button @click="toggleFullscreen" class="action-btn" title="全屏">
          <span v-if="!isFullscreen">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </span>
          <span v-else>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
            </svg>
          </span>
        </button>
      </div>
    </div>
    <Teleport to="body" :disabled="!isFullscreen">
      <div v-if="isFullscreen" class="chart-fullscreen-overlay">
        <div class="chart-fullscreen-header">
          <div class="chart-title">
            <span class="chart-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="18" y="13" width="4" height="9" rx="1"></rect>
                <rect x="12" y="7" width="4" height="15" rx="1"></rect>
                <rect x="6" y="15" width="4" height="7" rx="1"></rect>
              </svg>
            </span>
            <span>{{ title }}</span>
          </div>
          <div class="chart-actions">
            <button @click="downloadChart" class="action-btn" title="下载图表">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
            <button @click="toggleFullscreen" class="action-btn close-btn" title="退出全屏">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path
                  d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              </svg>
            </button>
          </div>
        </div>
        <div ref="fullscreenContainer" class="chart-fullscreen-content"></div>
      </div>
    </Teleport>

    <div ref="chartContainer" class="chart-container" v-show="!isFullscreen"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
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
const fullscreenContainer = ref(null);
const chartInstance = ref(null);
const isFullscreen = ref(false);

// 初始化图表
const initChart = (container) => {
  if (!container) return;

  // 销毁旧实例
  if (chartInstance.value) {
    chartInstance.value.dispose();
  }

  // 检测当前主题
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';

  // 创建新实例
  chartInstance.value = echarts.init(container, isDark ? 'dark' : null);

  // 基础配置 - 适配模式
  const baseOption = {
    backgroundColor: 'transparent',
    textStyle: {
      color: isDark ? '#a1a1aa' : '#52525b' // var(--color-text-secondary)
    },
    title: {
      textStyle: {
        color: isDark ? '#f4f4f5' : '#18181b' // var(--color-text-primary)
      }
    },
    legend: {
      textStyle: {
        color: isDark ? '#f4f4f5' : '#18181b'
      }
    },
    tooltip: {
      backgroundColor: isDark ? '#27272a' : '#ffffff', // var(--color-bg-secondary)
      borderColor: isDark ? '#3f3f46' : '#e4e4e7',     // var(--color-border)
      textStyle: {
        color: isDark ? '#f4f4f5' : '#18181b'
      }
    },
    xAxis: {
      axisLine: {
        lineStyle: {
          color: isDark ? '#52525b' : '#a1a1aa' // var(--color-text-muted)
        }
      },
      axisLabel: {
        color: isDark ? '#a1a1aa' : '#52525b'
      },
      splitLine: {
        lineStyle: {
          color: isDark ? '#3f3f46' : '#e4e4e7' // var(--color-bg-tertiary)
        }
      }
    },
    yAxis: {
      axisLine: {
        lineStyle: {
          color: isDark ? '#52525b' : '#a1a1aa'
        }
      },
      axisLabel: {
        color: isDark ? '#a1a1aa' : '#52525b'
      },
      splitLine: {
        lineStyle: {
          color: isDark ? '#3f3f46' : '#e4e4e7'
        }
      }
    }
  };

  // 合并配置
  const finalOption = {
    // ...baseOption,
    ...props.echartsConfig,
    // 确保 backgroundColor 是透明的，除非 config 里明确覆盖
    backgroundColor: props.echartsConfig.backgroundColor || 'transparent'
  };

  // 设置配置
  chartInstance.value.setOption(finalOption);

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
const toggleFullscreen = async () => {
  isFullscreen.value = !isFullscreen.value;

  // 等待 DOM 更新
  await nextTick();

  // 根据全屏状态重新初始化图表到正确的容器
  const targetContainer = isFullscreen.value ? fullscreenContainer.value : chartContainer.value;
  if (targetContainer) {
    initChart(targetContainer);
  }
};

// 下载图表
const downloadChart = () => {
  if (!chartInstance.value) return;

  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const backgroundColor = isDark ? '#18181b' : '#ffffff';

  const url = chartInstance.value.getDataURL({
    type: 'png',
    pixelRatio: 2,
    backgroundColor: backgroundColor
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
  initChart(chartContainer.value);

  // 监听主题变化
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === 'data-theme') {
        const targetContainer = isFullscreen.value ? fullscreenContainer.value : chartContainer.value;
        initChart(targetContainer);
      }
    });
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  });
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
  margin: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--glass-bg-light);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--glass-shadow);
  transition: all var(--transition-normal);
}

.chart-renderer:hover {
  border-color: var(--color-border-hover);
  background: var(--color-bg-secondary);
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
  transition: all var(--transition-fast);
}

.chart-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.chart-icon {
  font-size: 1rem;
  opacity: 0.9;
}

.chart-actions {
  display: flex;
  gap: var(--spacing-sm);
}

.action-btn {
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  padding: 6px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: 0.9rem;
  transition: all var(--transition-fast);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  cursor: pointer;
}

.action-btn:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-border-hover);
  color: var(--color-text-primary);
  /* transform: translateY(-1px);/ */
}

.action-btn:active {
  transform: translateY(0);
}

.chart-container {
  width: 100%;
  height: 400px;
  padding: var(--spacing-lg);
  transition: all var(--transition-normal);
  background: var(--color-bg-primary);
}

.chart-container.fullscreen {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 9999;
  background: var(--color-bg-app);
  padding: var(--spacing-2xl);
}

.chart-fullscreen-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 9999;
  background: var(--color-bg-app);
  display: flex;
  flex-direction: column;
}

.chart-fullscreen-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
}

.chart-fullscreen-content {
  flex: 1;
  width: 100%;
  padding: var(--spacing-lg);
  background: var(--color-bg-primary);
}

.close-btn {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
}

.close-btn:hover {
  background: var(--color-error-bg);
  color: var(--color-error);
  border-color: var(--color-error);
}
</style>