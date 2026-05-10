<template>
  <div class="markdown-body" v-html="renderedContent" @click="handleBlockAction"></div>
</template>

<script setup>
import { computed, onUnmounted, ref } from 'vue';
import { copyToClipboard } from '../../utils/clipboard';

const props = defineProps({
  content: { type: String, default: '' },
  renderMarkdown: { type: Function, required: true },
});

const emit = defineEmits(['notify']);

const COPY_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 10.5H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h5.5a2 2 0 0 1 2 2v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const COPIED_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const feedbackTimer = ref(null);

const renderedContent = computed(() => props.renderMarkdown(props.content));

onUnmounted(() => {
  if (feedbackTimer.value) clearTimeout(feedbackTimer.value);
});

const notify = (message, type = 'error') => {
  emit('notify', { message, type });
};

const copyTableAsText = (table) => {
  if (!table) return '';
  const rows = Array.from(table.querySelectorAll('tr'));
  return rows
    .map((row) => Array.from(row.querySelectorAll('th, td'))
      .map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim())
      .join('\t'))
    .filter(Boolean)
    .join('\n');
};

const setCopyFeedback = (button, copied) => {
  if (!(button instanceof HTMLElement)) return;
  if (feedbackTimer.value) {
    clearTimeout(feedbackTimer.value);
    feedbackTimer.value = null;
  }

  button.dataset.copied = copied ? 'true' : 'false';
  const icon = button.querySelector('.md-block-copy-btn__icon');
  if (icon) {
    icon.innerHTML = copied ? COPIED_ICON_SVG : COPY_ICON_SVG;
  }

  if (copied) {
    feedbackTimer.value = setTimeout(() => {
      button.dataset.copied = 'false';
      if (icon) icon.innerHTML = COPY_ICON_SVG;
      feedbackTimer.value = null;
    }, 1600);
  }
};

const getBlockCopyText = (button) => {
  const copyType = button.getAttribute('data-copy-type') || '';
  const rawPayload = button.getAttribute('data-copy-content') || '';

  if (copyType === 'code') {
    try {
      return decodeURIComponent(rawPayload);
    } catch {
      return rawPayload;
    }
  }

  if (copyType === 'table') {
    const block = button.closest('.md-table-block');
    return copyTableAsText(block?.querySelector('table'));
  }

  if (copyType === 'quote') {
    const block = button.closest('.md-quote-block');
    return (block?.querySelector('blockquote')?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  return '';
};

const handleBlockAction = async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest('.md-block-copy-btn')
    : null;
  if (!button) return;

  event.preventDefault();
  event.stopPropagation();

  const text = getBlockCopyText(button);
  if (!text) {
    setCopyFeedback(button, false);
    notify('无可复制内容');
    return;
  }

  const ok = await copyToClipboard(text);
  setCopyFeedback(button, ok);
  notify(ok ? '已复制到剪贴板' : '复制失败', ok ? 'success' : 'error');
};
</script>
