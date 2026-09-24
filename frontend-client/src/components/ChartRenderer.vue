<template>
  <div class="chart-renderer">
    <div class="chart-header">
      <div class="chart-title">
        <span class="chart-icon">
          <IconBarChart :size="16" />
        </span>
        <span>{{ title }}</span>
      </div>
      <div class="chart-actions">
        <Button variant="ghost" size="icon" aria-label="下载图表" title="下载图表" @click="downloadChart">
          <IconDownload />
        </Button>
        <Button variant="ghost" size="icon" aria-label="全屏" title="全屏" @click="toggleFullscreen">
          <span v-if="!isFullscreen">
            <IconExpand />
          </span>
          <span v-else>
            <IconMinimize />
          </span>
        </Button>
      </div>
    </div>
    <Teleport to="body" :disabled="!isFullscreen">
      <div v-if="isFullscreen" class="chart-fullscreen-overlay">
        <div class="chart-fullscreen-header">
          <div class="chart-title">
            <span class="chart-icon">
              <IconBarChart :size="16" />
            </span>
            <span>{{ title }}</span>
          </div>
          <div class="chart-actions">
            <Button variant="ghost" size="icon" aria-label="下载图表" title="下载图表" @click="downloadChart">
              <IconDownload />
            </Button>
            <Button variant="destructive" size="icon" aria-label="退出全屏" title="退出全屏" @click="toggleFullscreen">
              <IconMinimize />
            </Button>
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
import IconDownload from './icons/IconDownload.vue';
import IconBarChart from './icons/IconBarChart.vue';
import IconExpand from './icons/IconExpand.vue';
import IconMinimize from './icons/IconMinimize.vue';
import { Button } from './ui/button';
import * as echarts from 'echarts/core';
import { buildChartOption } from './files/chartOption.js';
import { useThemeStore } from '../stores/theme.js';
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
  DatasetComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  TransformComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  DatasetComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  TransformComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

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
const themeStore = useThemeStore();

const emit = defineEmits(['render-failed']);

// 读 CSS token：ECharts 不接受 CSS var，需解析为具体色值；主题切换时重算自动跟随
const readCssToken = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const readThemeTokens = () => ({
  textSecondary: readCssToken('--color-text-secondary'),
  textPrimary: readCssToken('--color-text-primary'),
  textMuted: readCssToken('--color-text-muted'),
  bgElevated: readCssToken('--color-bg-elevated'),
  border: readCssToken('--color-border')
});

// setOption 抛错发生在 Vue 渲染 flush 内，会把整条渲染队列打断、页面卡死：
// option 构建与设置都就地吞错，销毁半初始化实例并通知父组件降级展示，绝不外抛。
const applyOption = (userConfig, notMerge = false) => {
  try {
    chartInstance.value.setOption(buildChartOption(userConfig, readThemeTokens()), notMerge);
  } catch (error) {
    chartInstance.value?.dispose();
    chartInstance.value = null;
    emit('render-failed', error?.message || String(error));
  }
};

// 初始化图表
const initChart = (container) => {
  if (!container) return;

  // 销毁旧实例
  if (chartInstance.value) {
    chartInstance.value.dispose();
  }

  // 创建新实例
  chartInstance.value = echarts.init(container);

  // 构建最终配置（含主题色合并）并设置
  applyOption(props.echartsConfig);
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

  const backgroundColor = readCssToken('--color-bg-primary') || '#ffffff';

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

// 监听配置变化（使用公共配置合并函数）
watch(() => props.echartsConfig, (newConfig) => {
  if (chartInstance.value && newConfig) {
    applyOption(newConfig, true);
  }
}, { deep: true });

// 监听主题变化（替代原 MutationObserver）：主题切换时重新初始化图表以套用新配色
watch(() => themeStore.isDark, () => {
  const targetContainer = isFullscreen.value ? fullscreenContainer.value : chartContainer.value;
  initChart(targetContainer);
});

onMounted(() => {
  initChart(chartContainer.value);
  // resize 监听只注册一次（handleResize 引用稳定，随实例卸载移除；initChart 会被全屏/主题切换反复调用）
  window.addEventListener('resize', handleResize);
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
  transition: all 0.3s;
  container-type: inline-size; /* 启用容器查询 */
}

.chart-renderer:hover {
  border-color: var(--color-border-hover);
  background: var(--color-bg-secondary);
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md);
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border);
  transition: all 0.2s;
  gap: var(--spacing-sm);
  min-width: 0;
}

.chart-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-primary);
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.chart-title > span:not(.chart-icon) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chart-icon {
  font-size: var(--font-size-base);
  opacity: 0.9;
}

.chart-actions {
  display: flex;
  gap: var(--spacing-sm);
}

.chart-container {
  width: 100%;
  /* 使用 aspect-ratio 维护 16:9 的黄金比例 */
  aspect-ratio: 16 / 9;
  min-height: 300px;
  max-height: 600px;
  padding: var(--spacing-md);
  transition: all 0.3s;
  background: var(--color-bg-primary);
}

/* 响应式调整 */
@media (max-width: 767px) {
  .chart-container {
    /* 移动端使用 4:3 比例，更适合竖屏 */
    aspect-ratio: 4 / 3;
    min-height: 250px;
    max-height: 400px;
    padding: var(--spacing-sm);
  }
}

@media (min-width: 1440px) {
  .chart-container {
    /* 大屏幕保持 16:9，但允许更高 */
    max-height: 700px;
  }
}

/* 如果容器在网格中宽度受限，优先保持比例 */
@container (max-width: 500px) {
  .chart-container {
    aspect-ratio: 1 / 1;
    min-height: 250px;
  }
}

.chart-container.fullscreen {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: var(--z-toast);
  background: var(--color-bg-app);
  padding: var(--spacing-2xl);
}

.chart-fullscreen-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: var(--z-toast);
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
  gap: var(--spacing-sm);
  min-width: 0;
}

.chart-fullscreen-content {
  flex: 1;
  width: 100%;
  padding: var(--spacing-lg);
  background: var(--color-bg-primary);
}

/* 响应式：移动端全屏收缩 padding */
@media (max-width: 767px) {
  .chart-fullscreen-header {
    padding: var(--spacing-sm) var(--spacing-md);
  }

  .chart-fullscreen-content {
    padding: var(--spacing-sm);
  }
}
</style>
