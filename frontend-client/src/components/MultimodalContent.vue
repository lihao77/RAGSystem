<template>
  <div class="multimodal-container">
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
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 16px 0;
}
</style>
