<template>
  <div class="markdown-body" v-html="renderedContent" @click="handleBlockAction"></div>
</template>

<script setup>
import { onScopeDispose, onUnmounted, shallowRef, watch } from 'vue';
import { renderMarkdown } from '../../utils/markdown.js';
import { createStreamingMarkdownRenderer } from '../../utils/streamingMarkdown.js';
import { createMarkdownCopyAction } from '../../utils/markdownBlockActions.js';

const props = defineProps({
  content: { type: String, default: '' },
  streaming: { type: Boolean, default: false },
});

const emit = defineEmits(['notify', 'citation-click']);

const renderedContent = shallowRef('');
const renderer = createStreamingMarkdownRenderer({
  render: renderMarkdown,
  publish: html => { renderedContent.value = html; },
});
watch([() => props.content, () => props.streaming], ([content, streaming]) => {
  renderer.update(content, streaming);
}, { immediate: true });
onScopeDispose(renderer.dispose);

const notify = (message, type = 'error') => {
  emit('notify', { message, type });
};

const { handleCopyAction, releaseCopyFeedback } = createMarkdownCopyAction({ notify });

onUnmounted(releaseCopyFeedback);

const handleBlockAction = async (event) => {
  const citation = event.target instanceof Element ? event.target.closest('[data-citation-file-id]') : null;
  if (citation) {
    event.preventDefault();
    emit('citation-click', { file_id: citation.getAttribute('data-citation-file-id'), char_start: Number(citation.getAttribute('data-citation-char-start') || 0), heading: citation.getAttribute('data-citation-heading') || '' });
    return;
  }
  await handleCopyAction(event);
};
</script>
