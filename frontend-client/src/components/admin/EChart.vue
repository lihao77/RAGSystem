<template>
  <div ref="el" class="echart" :style="{ height }"></div>
</template>

<script setup>
/**
 * 管理端轻量 echarts 包装(区别于为 agent 工具设计的 ChartRenderer,后者带下载/全屏过重)。
 * 只负责:init / resize(ResizeObserver)/ dispose / option 变更 setOption。
 * 主题色由父组件 option 提供(切暗亮重建 option 即可触发 watch 重渲)。
 */
import { ref, onMounted, onUnmounted, watch } from 'vue';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, HeatmapChart } from 'echarts/charts';
import {
  CalendarComponent,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  HeatmapChart,
  CalendarComponent,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

const props = defineProps({
  option: { type: Object, required: true },
  height: { type: String, default: '280px' },
});

const el = ref(null);
let chart = null;
let ro = null;

function render() {
  if (chart && props.option) {
    chart.setOption(props.option, true);
  }
}

onMounted(() => {
  chart = echarts.init(el.value);
  ro = new ResizeObserver(() => chart?.resize());
  ro.observe(el.value);
  render();
});

onUnmounted(() => {
  ro?.disconnect();
  chart?.dispose();
  chart = null;
});

watch(() => props.option, render, { deep: true });
</script>

<style scoped>
.echart {
  width: 100%;
}
</style>
