<template>
  <div class="file-code-view markdown-body" @click="handleCopyAction">
    <div class="file-code-view__scroll" :style="scrollStyle" v-html="rendered"></div>
    <div v-if="truncated || note || oversized" class="file-code-view__note" role="note">
      <span v-if="truncated">内容超出内联展示上限，已截断</span>
      <span v-if="oversized">内容过大，已按纯文本展示（跳过语法高亮）</span>
      <span v-if="note">{{ note }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed, onUnmounted } from 'vue';
import { renderCodeBlock } from '../../utils/markdown.js';
import { HIGHLIGHT_CHAR_LIMIT } from './fileCategorize.js';
import { createMarkdownCopyAction } from '../../utils/markdownBlockActions.js';

const props = defineProps({
  text: { type: String, default: '' },
  language: { type: String, default: '' },
  truncated: { type: Boolean, default: false },
  note: { type: String, default: '' },
  /** 内容区最大高度（px），0 表示不限制（Dialog 全量展示）。 */
  maxHeight: { type: Number, default: 0 },
});

const emit = defineEmits(['notify']);

const oversized = computed(() => props.text.length > HIGHLIGHT_CHAR_LIMIT);
// 超限时传空语言：renderCodeBlock 走 escapeHtml 纯文本路径，跳过 hljs 高亮
const rendered = computed(() => renderCodeBlock(props.text, oversized.value ? '' : props.language));
const scrollStyle = computed(() => (props.maxHeight > 0
  ? { maxHeight: `${props.maxHeight}px`, overflowY: 'auto' }
  : undefined));

const { handleCopyAction, releaseCopyFeedback } = createMarkdownCopyAction({
  notify: (message, type) => emit('notify', { message, type }),
});
onUnmounted(releaseCopyFeedback);
</script>

<style scoped>
.file-code-view { width: 100%; }
/* md-special-block 自带外边距，文件场景贴紧宿主容器 */
.file-code-view :deep(.md-special-block) { margin: 0; }
.file-code-view__scroll { scrollbar-width: thin; }
.file-code-view__note {
  display: flex;
  gap: 8px;
  padding: 6px 14px;
  border-top: 1px dashed var(--color-border);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs, 0.75rem);
  background: var(--color-bg-secondary);
}
</style>
