<template>
  <div class="wpe-root">
    <div class="wpe-header">
      <span class="wpe-title">执行过程</span>
      <span v-if="running" class="wpe-running-dot"></span>
    </div>
    <div v-if="nodes.length === 0" class="wpe-empty">等待执行…</div>
    <div v-else class="wpe-list" ref="listRef">
      <ExecutionTimelineNode
        v-for="(node, i) in nodes"
        :key="i"
        :node="node"
        :depth="0"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch, nextTick } from 'vue'
import { buildExecutionTree } from '../../utils/executionTreeBuilder'
import ExecutionTimelineNode from './ExecutionTimelineNode.vue'

const props = defineProps({
  executionSteps: { type: Array, default: () => [] },
  subtasks: { type: Array, default: () => [] },
  running: { type: Boolean, default: false },
})

const listRef = ref(null)
const nodes = computed(() => buildExecutionTree(props.executionSteps, props.subtasks))

watch(() => nodes.value.length, async () => {
  if (!props.running) return
  await nextTick()
  const el = listRef.value
  if (el) el.scrollTop = el.scrollHeight
})
</script>

<style scoped>
.wpe-root {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid var(--color-border);
}

.wpe-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px 6px;
  flex-shrink: 0;
}

.wpe-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.wpe-running-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-brand-accent, #6366f1);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

.wpe-empty {
  padding: 12px 14px;
  font-size: 12px;
  color: var(--color-text-muted);
  font-style: italic;
}

.wpe-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 10px 16px 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
}

.wpe-list::-webkit-scrollbar { width: 3px; }
.wpe-list::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 2px;
}
</style>
