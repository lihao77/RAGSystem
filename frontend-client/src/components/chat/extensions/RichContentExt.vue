<template>
  <div class="rich-content">
    <template v-for="(part, index) in parts" :key="index">
      <div v-if="part.type === 'text' && part.text?.trim()" class="final-answer">
        <MarkdownContent
          :content="part.text"
          :streaming="isStreaming && index === lastTextIndex"
          @notify="emit('notify', $event)"
          @citation-click="emit('citation-click', $event)"
        />
      </div>
      <div
        v-else-if="part.type === 'file_ref'"
        class="inline-file-wrapper"
        :data-file-path="part.file_path"
        :data-message-key="messageKey || undefined"
        :data-message-id="messageId || undefined"
        :data-message-seq="messageSeq != null ? String(messageSeq) : undefined"
        :data-run-id="runId || undefined"
      >
        <VisualizationLoader
          :session-id="currentSessionId"
          :file-path="part.file_path"
          :presentation="part.presentation"
          :caption="part.caption || ''"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, inject } from 'vue';
import MarkdownContent from '../MarkdownContent.vue';
import VisualizationLoader from '../../VisualizationLoader.vue';

const props = defineProps({
  data: { type: Object, required: true },
  msg: { type: Object, required: true },
  sessionId: { type: String, default: '' },
});

const emit = defineEmits(['notify', 'citation-click']);
const messageContext = inject('messageContext');
const parts = computed(() => Array.isArray(props.data?.parts) ? props.data.parts : []);
const currentSessionId = computed(() => props.sessionId || messageContext?.currentSessionId?.value || messageContext?.currentSessionId || '');
const messageKey = computed(() => (
  messageContext?.getWorkPanelMessageKey?.(props.msg)
  || (props.msg?.id ? `id:${props.msg.id}` : props.msg?.seq != null ? `seq:${props.msg.seq}` : '')
));
const messageId = computed(() => props.msg?.id || '');
const messageSeq = computed(() => props.msg?.seq ?? null);
const runId = computed(() => props.msg?.run_id || props.msg?.metadata?.run_id || '');
const isStreaming = computed(() => !props.msg.finished && !props.msg.stopped);
const lastTextIndex = computed(() => {
  for (let index = parts.value.length - 1; index >= 0; index -= 1) {
    if (parts.value[index]?.type === 'text' && parts.value[index]?.text?.trim()) return index;
  }
  return -1;
});
</script>

<style scoped>
.rich-content { min-width: 0; width: 100%; }
.inline-file-wrapper { width: 100%; }
</style>
