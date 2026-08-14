<template>
  <div class="file-tree-scroll">
    <template v-for="node in nodes" :key="node.path">
      <button
        v-if="node.type === 'directory'"
        type="button"
        class="file-row"
        :style="{ paddingLeft: `${10 + node.depth * 16}px` }"
        @click="emit('toggle', node.path)"
      >
        <ChevronDown :class="['file-row__chevron', { 'file-row__chevron--closed': node.collapsed }]" />
        <span>{{ node.name }}</span>
      </button>
      <a
        v-else-if="hrefFor"
        :href="hrefFor(node.path)"
        target="_blank"
        rel="noopener"
        class="file-row file-row--link"
        :style="{ paddingLeft: `${10 + node.depth * 16}px` }"
      >
        <FileText />
        <span>{{ node.name }}</span>
        <small>{{ formatSize(node.size) }}</small>
      </a>
      <button
        v-else
        type="button"
        :class="['file-row', { 'file-row--active': selectedPath === node.path }]"
        :style="{ paddingLeft: `${10 + node.depth * 16}px` }"
        @click="emit('select', node.path)"
      >
        <FileText />
        <span>{{ node.name }}</span>
        <small v-if="node.size != null">{{ formatSize(node.size) }}</small>
      </button>
    </template>
  </div>
</template>

<script setup>
// Skill bundle 文件树：draft 可点选编辑；published 只读（传 hrefFor 则文件渲染为下载链接）。
import { ChevronDown, FileText } from 'lucide-vue-next';

import { formatSize } from '../../utils/skillFiles.js';

defineProps({
  nodes: { type: Array, required: true },
  selectedPath: { type: String, default: '' },
  hrefFor: { type: Function, default: null },
});

const emit = defineEmits(['select', 'toggle']);
</script>

<style scoped>
.file-tree-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--spacing-xs);
}

.file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 30px;
  padding-top: 4px;
  padding-right: 8px;
  padding-bottom: 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  text-align: left;
  text-decoration: none;
}

button.file-row {
  cursor: pointer;
}

button.file-row:hover,
.file-row--active,
.file-row--link:hover {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.file-row--active {
  box-shadow: inset 2px 0 0 var(--color-brand-accent);
}

.file-row--link:focus-visible {
  outline: 2px solid var(--color-brand-accent);
  outline-offset: -2px;
}

.file-row svg {
  width: 14px;
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.file-row__chevron {
  transition: transform var(--transition-fast);
}

.file-row__chevron--closed {
  transform: rotate(-90deg);
}

.file-row span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-row--link:hover span {
  text-decoration: underline;
}

.file-row small {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: 10px;
}
</style>
