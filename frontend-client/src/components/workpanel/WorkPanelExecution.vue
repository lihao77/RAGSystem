<template>
  <div class="wpe-root">
    <div class="wpe-header">
      <div class="wpe-heading">
        <span class="wpe-title">执行过程</span>
        <span class="wpe-summary">{{ summaryText }}</span>
      </div>
      <div class="wpe-meta">
        <span v-if="stats.running > 0" class="wpe-chip chip-running">
          <span class="wpe-running-dot"></span>
          {{ stats.running }}
        </span>
        <span v-if="stats.error > 0" class="wpe-chip chip-error">{{ stats.error }} 失败</span>
        <span v-else-if="stats.success > 0" class="wpe-chip chip-success">{{ stats.success }} 完成</span>
      </div>
    </div>
    <div v-if="nodes.length === 0" class="wpe-empty">
      <span class="wpe-empty-mark" aria-hidden="true"></span>
      <span>{{ running ? '等待第一步执行' : '暂无执行过程' }}</span>
    </div>
    <div v-else class="wpe-list" ref="listRef">
      <ExecutionTimelineNode
        v-for="(node, i) in nodes"
        :key="nodeKey(node, i)"
        :node="node"
        :depth="0"
        :session-id="sessionId"
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
  sessionId: { type: String, default: '' },
})

const listRef = ref(null)
const nodes = computed(() => buildExecutionTree(props.executionSteps, props.subtasks))
const flatNodes = computed(() => flattenNodes(nodes.value))

const stats = computed(() => {
  const values = { total: 0, agent: 0, tool: 0, running: 0, success: 0, error: 0 }
  flatNodes.value.forEach(node => {
    values.total += 1
    if (node.type === 'agent_call') values.agent += 1
    if (node.type === 'tool_call') values.tool += 1
    const status = normalizeStatus(node.status)
    if (status === 'running') values.running += 1
    if (status === 'success') values.success += 1
    if (status === 'error') values.error += 1
  })
  return values
})

const summaryText = computed(() => {
  if (!stats.value.total) return props.running ? '准备中' : '无记录'
  const parts = [`${stats.value.total} 步`]
  if (stats.value.agent) parts.push(`${stats.value.agent} Agent`)
  if (stats.value.tool) parts.push(`${stats.value.tool} 工具`)
  return parts.join(' / ')
})

const scrollSignature = computed(() => flatNodes.value.map((node, index) => [
  index,
  node.type,
  node.call_id || node.task_id || node.round || '',
  node.status || '',
  node.children?.length || 0,
].join(':')).join('|'))

watch(scrollSignature, async () => {
  if (!props.running) return
  await nextTick()
  const el = listRef.value
  if (el) el.scrollTop = el.scrollHeight
})

function flattenNodes(items = []) {
  const result = []
  const walk = (children) => {
    children.forEach(child => {
      result.push(child)
      if (Array.isArray(child.children) && child.children.length > 0) {
        walk(child.children)
      }
    })
  }
  walk(items)
  return result
}

function normalizeStatus(status) {
  if (status === 'completed' || status === 'success') return 'success'
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'running') return 'running'
  return status || 'pending'
}

function nodeKey(node, index) {
  return node.call_id || node.task_id || `${node.type}-${node.round || ''}-${index}`
}
</script>

<style scoped>
.wpe-root {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid var(--color-border);
  letter-spacing: 0;
}

.wpe-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 12px 14px 10px;
  flex-shrink: 0;
}

.wpe-heading {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

.wpe-title {
  font-size: 13px;
  line-height: 1.25;
  font-weight: 650;
  color: var(--color-text-primary);
}

.wpe-summary {
  font-size: 11px;
  line-height: 1.25;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wpe-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.wpe-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  font-size: 11px;
  font-weight: 650;
  line-height: 1;
  white-space: nowrap;
}

.chip-running {
  color: var(--color-brand-accent);
  border-color: rgba(var(--color-brand-accent-rgb), 0.26);
  background: rgba(var(--color-brand-accent-rgb), 0.1);
}

.chip-error {
  color: var(--color-error);
  border-color: rgba(var(--color-error-rgb), 0.24);
  background: rgba(var(--color-error-rgb), 0.09);
}

.chip-success {
  color: var(--color-success);
  border-color: rgba(var(--color-success-rgb), 0.22);
  background: rgba(var(--color-success-rgb), 0.08);
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
  margin: 0 14px;
  padding: 14px 12px;
  font-size: 12px;
  color: var(--color-text-muted);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.24);
  display: flex;
  align-items: center;
  gap: 8px;
}

.wpe-empty-mark {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--color-border);
  flex-shrink: 0;
}

.wpe-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px 18px 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
}

.wpe-list::-webkit-scrollbar { width: 3px; }
.wpe-list::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 2px;
}
</style>
