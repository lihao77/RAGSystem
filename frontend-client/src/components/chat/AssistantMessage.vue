<template>
  <div
    v-if="!msg.content && (!msg.subtasks || msg.subtasks.length === 0) && !msg.finished"
    class="loading-indicator"
  >
    <div class="loading-dots" aria-hidden="true">
      <div class="dot"></div>
      <div class="dot"></div>
      <div class="dot"></div>
    </div>
    <span class="loading-text">{{ getAssistantRuntimeStatusText(msg) || '正在运行...' }}</span>
  </div>

  <template v-for="(part, pi) in parseMessageParts(msg)" :key="pi">
    <div v-if="part.type === 'text' && part.content?.trim()" class="final-answer">
      <MarkdownContent
        :content="part.content"
        :render-markdown="renderMarkdown"
        @notify="emit('notify', $event)"
      />
    </div>
    <div v-else-if="part.type === 'viz'" class="inline-chart-wrapper">
      <VisualizationLoader :artifactId="part.artifactId" @enter-situation="handleEnterSituation" />
    </div>
  </template>

  <div v-if="msg.stopped" class="stopped-badge">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="6" y="6" width="12" height="12" rx="2"></rect>
    </svg>
    <span>{{ msg.metadata?.interrupted ? '已中断' : '已停止生成' }}</span>
  </div>
</template>

<script setup>
import MarkdownContent from './MarkdownContent.vue';
import VisualizationLoader from '../VisualizationLoader.vue';

defineProps({
  msg: { type: Object, required: true },
  getAssistantRuntimeStatusText: { type: Function, required: true },
  parseMessageParts: { type: Function, required: true },
  renderMarkdown: { type: Function, required: true },
  handleEnterSituation: { type: Function, required: true },
});

const emit = defineEmits(['notify']);
</script>
