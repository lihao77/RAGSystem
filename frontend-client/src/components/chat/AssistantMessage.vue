<template>
  <div
    v-if="!msg.content && !msg.finished"
    class="loading-indicator"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <Spinner aria-hidden="true" />
    <span class="loading-text">{{ messageContext.getAssistantRuntimeStatusText(msg) || '正在运行...' }}</span>
  </div>

  <template v-for="(part, pi) in parseMessageParts(msg)" :key="pi">
    <div v-if="part.type === 'text' && part.content?.trim()" class="final-answer">
      <MarkdownContent
        :content="part.content"
        :streaming="isStreaming && pi === lastTextIndex"
        @notify="emit('notify', $event)"
        @citation-click="emit('citation-click', $event)"
      />
    </div>
    <div
      v-else-if="part.type === 'artifact'"
      class="inline-chart-wrapper"
      :data-artifact-id="part.artifactId"
    >
      <VisualizationLoader :artifactId="part.artifactId" @enter-situation="messageContext.handleEnterSituation" />
    </div>
  </template>

  <div v-if="msg.stopped" class="stopped-badge">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="6" y="6" width="12" height="12" rx="2"></rect>
    </svg>
    <span>已停止生成</span>
  </div>
</template>

<script setup>
import MarkdownContent from './MarkdownContent.vue';
import VisualizationLoader from '../VisualizationLoader.vue';
import { Spinner } from '@/components/ui/spinner';
import { parseMessageParts } from '../../utils/message-render.js';
import { inject, computed } from 'vue';

const props = defineProps({
  msg: { type: Object, required: true },
});

const emit = defineEmits(['notify', 'citation-click']);
const messageContext = inject('messageContext');

// 流式中（未停止且未结束）→ 显示呼吸光标
const isStreaming = computed(() => !props.msg.finished && !props.msg.stopped);

// 光标只挂在最后一个文本块末尾
const lastTextIndex = computed(() => {
  const parts = parseMessageParts(props.msg);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].type === 'text' && parts[i].content?.trim()) return i;
  }
  return -1;
});
</script>
