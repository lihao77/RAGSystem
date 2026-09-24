<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent class="flex h-[90vh] max-w-[1100px] flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2 min-w-0">
          <component :is="categoryIcon" :size="16" class="shrink-0 text-muted-foreground" />
          <span class="truncate" :title="title">{{ title }}</span>
        </DialogTitle>
        <DialogDescription class="truncate">
          {{ fileName }}<template v-if="meta"> · {{ meta }}</template>
        </DialogDescription>
      </DialogHeader>

      <div class="flex min-h-0 flex-1 flex-col">
        <!-- 文本类：滚动区域承载全文（图表数据解析失败时也按 JSON 走此分支） -->
        <div
          v-if="isTextual"
          class="file-preview-dialog__scroll min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-elevated p-4"
        >
          <MarkdownContent v-if="category === 'markdown'" :content="text || '（空文件）'" @notify="payload => emit('notify', payload)" />
          <FileCodeView
            v-else
            :text="text"
            :language="category === 'json' || category === 'chart' ? 'json' : language"
            :truncated="truncated"
            :note="chartFallbackNote"
            @notify="payload => emit('notify', payload)"
          />
        </div>

        <!-- 交互图表：撑满视口；渲染失败降级为上方文本分支按 JSON 展示 -->
        <div v-else-if="category === 'chart' && chartSpec?.ok" class="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          <ChartRenderer :echarts-config="chartSpec.option" :title="title" @render-failed="onChartRenderFailed" />
        </div>

        <!-- CSV：全行数表格 -->
        <FileCsvTable
          v-else-if="category === 'csv'"
          class="min-h-0 flex-1 rounded-lg border border-border"
          :text="text"
          :delimiter="delimiter"
          :max-rows="csvDialogRows"
          :truncated="truncated"
        />

        <!-- 二进制类：撑满视口 -->
        <div v-else-if="category === 'pdf' && objectUrl" class="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          <iframe :src="objectUrl" :title="title" class="h-full w-full border-0" />
        </div>
        <div v-else-if="category === 'html' && objectUrl" class="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-white">
          <iframe :src="objectUrl" sandbox="" :title="title" class="h-full w-full border-0" />
        </div>
        <div v-else-if="(category === 'audio' || category === 'video') && objectUrl" class="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border p-6">
          <video v-if="category === 'video'" controls :src="objectUrl" class="max-h-full max-w-full" />
          <audio v-else controls :src="objectUrl" class="w-full max-w-xl" />
        </div>

        <div v-else class="flex flex-1 items-center justify-center py-12 text-sm text-muted-foreground">
          该文件类型暂不支持预览
        </div>
      </div>

      <div class="flex items-center justify-between gap-3 border-t border-border pt-3">
        <span class="text-xs text-muted-foreground">{{ truncated ? '内容较长，已截断展示' : '' }}</span>
        <Button variant="outline" size="sm" :disabled="downloading" @click="emit('download')">
          <Download />
          {{ downloading ? '下载中…' : '下载文件' }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Download } from 'lucide-vue-next';
import MarkdownContent from '../chat/MarkdownContent.vue';
import FileCodeView from './FileCodeView.vue';
import FileCsvTable from './FileCsvTable.vue';
import ChartRenderer from '../ChartRenderer.vue';
import { parseChartSpec } from './chartSpec.js';
import { getCategoryIcon } from './categoryIcons.js';
import { CSV_DIALOG_ROWS } from './fileCategorize.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  fileName: { type: String, default: '' },
  meta: { type: String, default: '' },
  category: { type: String, default: 'other' },
  language: { type: String, default: '' },
  delimiter: { type: String, default: ',' },
  text: { type: String, default: '' },
  truncated: { type: Boolean, default: false },
  objectUrl: { type: String, default: '' },
  downloading: { type: Boolean, default: false },
});

const emit = defineEmits(['update:open', 'download', 'notify']);

const csvDialogRows = CSV_DIALOG_ROWS;
const chartSpec = computed(() => (props.category === 'chart' ? parseChartSpec(props.text) : null));
// 交互图表 setOption 失败时记录原因，并入文本分支按 JSON 展示
const chartRenderError = ref('');
watch(() => [props.fileName, props.text], () => {
  chartRenderError.value = '';
});
// 图表数据解析失败时并入文本分支按 JSON 展示
const isTextual = computed(() => ['markdown', 'code', 'json'].includes(props.category)
  || (props.category === 'chart' && (!chartSpec.value?.ok || chartRenderError.value)));
// 文本分支的说明文案：区分"解析失败"与"渲染失败"
const chartFallbackNote = computed(() => {
  if (props.category !== 'chart') return props.truncated ? '完整内容超出预览上限' : '';
  if (chartRenderError.value) return `图表渲染失败（${chartRenderError.value}），已按 JSON 展示`;
  return `图表数据无法解析（${chartSpec.value?.reason || '未知原因'}），已按 JSON 展示`;
});
const categoryIcon = computed(() => getCategoryIcon(props.category));
const onChartRenderFailed = (message) => {
  chartRenderError.value = message;
};
</script>
