<template>
  <div
    v-if="showLoadingIndicator"
    class="loading-indicator"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <Spinner aria-hidden="true" />
    <span class="loading-text">{{ messageContext.getAssistantRuntimeStatusText(msg) || '正在运行...' }}</span>
  </div>

  <MessageContentParts
    v-if="hasContentParts"
    :parts="msg.content_parts"
    :msg="msg"
    @notify="emit('notify', $event)"
    @citation-click="emit('citation-click', $event)"
  />

  <div v-else-if="msg.content?.trim()" class="final-answer">
    <MarkdownContent
      :content="msg.content"
      :streaming="isStreaming"
      @notify="emit('notify', $event)"
      @citation-click="emit('citation-click', $event)"
    />
  </div>

</template>

<script setup>
import MarkdownContent from './MarkdownContent.vue';
import MessageContentParts from './MessageContentParts.vue';
import { Spinner } from '@/components/ui/spinner';
import { inject, computed } from 'vue';

const props = defineProps({
  msg: { type: Object, required: true },
});

const emit = defineEmits(['notify', 'citation-click']);
const messageContext = inject('messageContext');

// 流式中（未停止且未结束）→ 显示呼吸光标
const isStreaming = computed(() => !props.msg.finished && !props.msg.stopped);
const hasContentParts = computed(() => Array.isArray(props.msg.content_parts) && props.msg.content_parts.length > 0);
const showLoadingIndicator = computed(() => !props.msg.content && !props.msg.finished);

</script>
