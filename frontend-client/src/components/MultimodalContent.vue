<template>
  <div class="multimodal-container" :class="{ 'single-item': contents.length === 1, 'dual-items': contents.length === 2 }">
    <!-- 渲染不同类型的模态内容 -->
    <component
      :is="getRendererComponent(item.type)"
      v-for="(item, index) in contents"
      :key="`${item.type}-${index}`"
      v-bind="getRendererProps(item)"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue';
import ChartRenderer from './ChartRenderer.vue';
import MapRenderer from './MapRenderer.vue';

const props = defineProps({
  contents: {
    type: Array,
    default: () => [],
    // 数据格式示例:
    // [
    //   { type: 'chart', echartsConfig: {...}, title: '图表标题', chartType: 'bar' },
    //   { type: 'map', mapData: {...}, title: '地图标题' },
    //   { type: 'table', tableData: [...], columns: [...] }
    // ]
  }
});

// 模态类型与组件的映射
const RENDERER_MAP = {
  chart: ChartRenderer,
  map: MapRenderer,
  // 未来扩展:
  // table: TableRenderer,
  // image: ImageRenderer,
  // video: VideoRenderer,
  // timeline: TimelineRenderer,
  // graph: GraphRenderer
};

// 获取对应的渲染组件
const getRendererComponent = (type) => {
  return RENDERER_MAP[type] || null;
};

// 获取渲染器需要的 props
const getRendererProps = (item) => {
  const { type, ...rest } = item;
  return rest;
};
</script>

<style scoped>
.multimodal-container {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(400px, 100%), 1fr));
  gap: var(--spacing-lg);
  margin: var(--spacing-md) 0;
  background: transparent;
  width: 100%;
}

/* 单个项目时占满宽度 - 使用类名而不是 :has() */
.multimodal-container.single-item {
  grid-template-columns: 1fr;
}

/* 两个项目时 1:1 分配 - 使用类名而不是 :has() */
.multimodal-container.dual-items {
  grid-template-columns: repeat(2, 1fr);
}

/* 确保子组件符合整体风格 */
.multimodal-container > * {
  animation: fadeInUp 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  min-width: 0; /* 防止内容溢出 */
}

/* 响应式：移动端强制单列 */
@media (max-width: 768px) {
  .multimodal-container {
    grid-template-columns: 1fr !important;
    gap: var(--spacing-md);
  }
}

/* 响应式：平板端最多两列 */
@media (max-width: 1024px) and (min-width: 769px) {
  .multimodal-container {
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  }

  /* 三个及以上时强制两列 */
  .multimodal-container:not(.single-item):not(.dual-items) {
    grid-template-columns: repeat(2, 1fr);
  }
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
</style>
