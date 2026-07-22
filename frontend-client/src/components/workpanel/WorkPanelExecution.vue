<template>
  <div class="wpe-root">
    <div class="wpe-header">
      <div class="wpe-heading">
        <span class="wpe-title">{{ executionView.title }}</span>
        <span class="wpe-summary">{{ executionView.summary }}</span>
      </div>
      <div class="wpe-meta">
        <component
          :is="item.action ? 'button' : 'span'"
          v-for="item in executionView.meta"
          :key="item.id"
          type="button"
          class="wpe-chip"
          :class="`chip-${item.tone}`"
          :title="item.title"
          @click="handleMetaAction(item.action)"
        >
          <span v-if="item.pulse" class="wpe-running-dot"></span>
          {{ item.label }}
        </component>
      </div>
    </div>
   <div class="wpe-body-state">
     <Transition name="wpe-state" mode="out-in">
        <div v-if="!executionView.hasNodes" class="wpe-empty" key="empty">
          <span class="wpe-empty-mark" aria-hidden="true"></span>
          <span>{{ executionView.emptyText }}</span>
        </div>
        <div v-else class="wpe-list" key="list">
         <Transition name="wpe-tree-swap" mode="out-in" appear>
            <div class="wpe-scroll" :key="messageKey" ref="listRef">
              <TransitionGroup name="wpe-node" tag="div" class="wpe-node-stack">
                <ExecutionTimelineNode
                  v-for="(node, i) in executionView.nodes"
                  :key="timelineNodeKey(node, i)"
                  :node="node"
                  :depth="0"
                  :session-id="sessionId"
                  :focus-key="focusKey"
                  :selected-key="selectedKey"
                  @inspect="selectNode"
                />
              </TransitionGroup>
            </div>
          </Transition>
        </div>
      </Transition>
    </div>

    <div class="wpe-inspector-slot" :class="{ 'is-open': selectedNode }">
      <Transition name="wpe-inspector">
        <WorkPanelInspector v-if="selectedNode" :node="selectedNode" @close="clearSelectedNode" />
      </Transition>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch, nextTick, onUnmounted } from 'vue'
import { buildExecutionTree } from '../../utils/executionTreeBuilder'
import {
  flattenExecutionNodes as flattenNodes,
  getExecutionNodeKey as getNodeKey,
  normalizeExecutionStatus as normalizeStatus,
} from '../../utils/executionTreePresentation'
import ExecutionTimelineNode from './ExecutionTimelineNode.vue'
import WorkPanelInspector from './WorkPanelInspector.vue'

const props = defineProps({
  executionTree: { type: Object, default: () => ({ root: null, steps: [] }) },
  injections: { type: Array, default: () => [] },
  running: { type: Boolean, default: false },
  sessionId: { type: String, default: '' },
  messageKey: { type: String, default: '' },
})

const listRef = ref(null)
const selectedNodeKey = ref('')
let selectionScrollTimer = null
const nodes = computed(() => buildExecutionTree(props.executionTree, props.injections))

const flatNodes = computed(() => flattenNodes(nodes.value))
const focusNode = computed(() => findFocusNode(flatNodes.value))
const focusKey = computed(() => focusNode.value ? getNodeKey(focusNode.value) : '')
const selectedNode = computed(() => findNodeByKey(flatNodes.value, selectedNodeKey.value))
const selectedKey = computed(() => selectedNodeKey.value)

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

const executionView = computed(() => {
  const total = stats.value.total
  const meta = []

  if (stats.value.running > 0) {
    meta.push({
      id: 'running',
      tone: 'running',
      label: String(stats.value.running),
      title: '定位运行中步骤',
      action: 'focus-running',
      pulse: true,
    })
  }

  if (stats.value.error > 0) {
    meta.push({
      id: 'error',
      tone: 'error',
      label: `${stats.value.error} 失败`,
      title: '定位失败步骤',
      action: 'focus-error',
    })
  } else if (stats.value.success > 0) {
    meta.push({
      id: 'success',
      tone: 'success',
      label: `${stats.value.success} 完成`,
      title: '已完成步骤',
    })
  }

  return {
   title: '执行过程',
   hasNodes: total > 0,
    nodes: nodes.value,
   summary: total ? formatExecutionSummary(stats.value) : (props.running ? '准备中' : '无记录'),
    emptyText: props.running ? '等待第一步执行' : '暂无执行过程',
    meta,
  }
})

function formatExecutionSummary(values) {
  const parts = [`${values.total} 步`]
  if (values.agent) parts.push(`${values.agent} Agent`)
  if (values.tool) parts.push(`${values.tool} 工具`)
  return parts.join(' / ')
}

const scrollSignature = computed(() => flatNodes.value.map((node, index) => [
  index,
  node.type,
  node.call_id || node.task_id || node.round || '',
  node.status || '',
  node.children?.length || 0,
].join(':')).join('|'))

watch(scrollSignature, async () => {
  if (!props.running) return
  const shouldFollow = !listRef.value || isListNearBottom(listRef.value)
  await nextTick()
  const el = listRef.value
  if (el && shouldFollow) el.scrollTop = el.scrollHeight
})

watch(selectedNode, (node) => {
  if (selectedNodeKey.value && !node) {
    clearSelectedNode()
  }
})

watch(() => props.messageKey, () => {
  clearSelectedNode()
})

function findNodeByKey(items, key) {
  if (!key) return null
  return items.find(node => getNodeKey(node) === key) || null
}

function nodeKey(node, index) {
  return node.call_id || node.task_id || `${node.type}-${node.round || ''}-${index}`
}

function timelineNodeKey(node, index) {
  return nodeKey(node, index)
}

async function selectNode(node) {
  const key = getNodeKey(node)
  selectedNodeKey.value = key
  await nextTick()
  scrollNodeIntoView(key)
  scheduleSelectionScrollCorrection(key)
}

function clearSelectedNode() {
  selectedNodeKey.value = ''
  if (selectionScrollTimer) {
    clearTimeout(selectionScrollTimer)
    selectionScrollTimer = null
  }
}

async function focusNodeInList(node) {
  if (!node) return
  await nextTick()
  scrollNodeIntoView(getNodeKey(node))
}

function focusErrorNode() {
  const node = findLastByStatus('error')
  focusNodeInList(node)
}

function focusRunningNode() {
  const node = findLastByStatus('running')
  focusNodeInList(node)
}

function handleMetaAction(action) {
  if (action === 'focus-running') {
    focusRunningNode()
  } else if (action === 'focus-error') {
    focusErrorNode()
  }
}

function findLastByStatus(status) {
  for (let i = flatNodes.value.length - 1; i >= 0; i -= 1) {
    if (normalizeStatus(flatNodes.value[i]?.status) === status) return flatNodes.value[i]
  }
  return null
}

function scrollNodeIntoView(key) {
  if (!key || !listRef.value) return
  const selectorKey = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/"/g, '\\"')
  const target = listRef.value.querySelector(`[data-node-key="${selectorKey}"]`)
  if (!target) return
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const viewportHeight = listRef.value.clientHeight
  const targetTop = target.offsetTop
  const targetHeight = target.offsetHeight
  const nextTop = Math.max(0, targetTop - Math.max(0, (viewportHeight - targetHeight) / 2))
  listRef.value.scrollTo({ top: nextTop, behavior: reduceMotion ? 'auto' : 'smooth' })
}

function scheduleSelectionScrollCorrection(key) {
  if (selectionScrollTimer) clearTimeout(selectionScrollTimer)
  selectionScrollTimer = setTimeout(() => {
    if (selectedNodeKey.value === key) scrollNodeIntoView(key)
    selectionScrollTimer = null
  }, 220)
}

onUnmounted(() => {
  if (selectionScrollTimer) clearTimeout(selectionScrollTimer)
})

function isListNearBottom(el) {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 36
}

function findFocusNode(items) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (normalizeStatus(items[i]?.status) === 'error') return items[i]
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (normalizeStatus(items[i]?.status) === 'running') return items[i]
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (isWaitingUserInputNode(items[i])) return items[i]
  }
  return items[items.length - 1] || null
}

function isWaitingUserInputNode(node) {
  if (node?.tool_name !== 'request_user_input') return false
  const status = normalizeStatus(node.status)
  return props.running && (status === 'pending' || status === 'running')
}

</script>

<style scoped>
.wpe-root {
  --wpe-inspector-height: clamp(220px, 38%, 420px);
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border-top: none;
  letter-spacing: 0;
  position: relative;
}

.wpe-root::before {
  content: '';
  display: block;
  height: 1px;
  flex-shrink: 0;
  background: linear-gradient(90deg, transparent 4%, var(--color-border) 30%, var(--color-border) 70%, transparent 96%);
}

.wpe-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  min-height: 54px;
  padding: 10px 14px;
  flex-shrink: 0;
}

.wpe-heading {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
  flex: 1 1 auto;
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
  transition: color var(--transition-fast);
}

.wpe-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  max-width: 42%;
  min-width: 72px;
  justify-content: flex-end;
  overflow: hidden;
}

.wpe-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 24px;
  min-width: 28px;
  max-width: 96px;
  padding: 0 8px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  font-size: 11px;
  font-weight: 650;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: inherit;
  cursor: default;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast),
    color var(--transition-fast);
}

button.wpe-chip {
  cursor: pointer;
}

button.wpe-chip:hover {
  border-color: var(--color-border-hover);
  background: var(--surface-shell);
}

.chip-running {
  color: var(--color-brand-accent);
  border-color: rgba(var(--color-brand-accent-rgb), 0.26);
  background: rgba(var(--color-brand-accent-rgb), 0.1);
}

.chip-running:hover {
  border-color: rgba(var(--color-brand-accent-rgb), 0.34);
  background: rgba(var(--color-brand-accent-rgb), 0.14);
}

.chip-error {
  color: var(--color-error);
  border-color: rgba(var(--color-error-rgb), 0.24);
  background: rgba(var(--color-error-rgb), 0.09);
}

.chip-error:hover {
  border-color: rgba(var(--color-error-rgb), 0.34);
  background: rgba(var(--color-error-rgb), 0.13);
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
  background: var(--color-brand-accent);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

.wpe-body-state {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.wpe-empty {
  margin: 0 14px;
  padding: 14px 12px;
  font-size: 12px;
  color: var(--color-text-muted);
  border: 1px solid color-mix(in srgb, var(--color-border) 52%, transparent);
  border-radius: var(--radius-sm);
  background:
    linear-gradient(135deg, rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.28), rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.12));
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
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.wpe-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
  padding: 0 12px 12px 10px;
}

.wpe-node-stack {
  --rail-width: 22px;
  --rail-dot-top: 17px;
  --rail-dot-size: 9px;
  --rail-dot-center: calc(var(--rail-dot-top) + (var(--rail-dot-size) / 2));
  --timeline-rail-thickness: 2px;
  position: relative;
}

.wpe-node-stack::before {
  content: '';
  position: absolute;
  left: calc((var(--rail-width) - var(--timeline-rail-thickness)) / 2);
  top: var(--rail-dot-center);
  bottom: 0;
  width: var(--timeline-rail-thickness);
  border-radius: var(--radius-full);
  background: var(--color-border);
  opacity: 0.7;
  pointer-events: none;
  mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 14px), transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 14px), transparent 100%);
}

.wpe-scroll::-webkit-scrollbar { width: 3px; }
.wpe-scroll::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 2px;
  transition: background 0.25s;
}
.wpe-scroll:hover::-webkit-scrollbar-thumb {
  background: var(--color-border);
}
.wpe-scroll:hover::-webkit-scrollbar-thumb:hover {
  background: var(--color-border-hover);
}

.wpe-list-state-enter-active,
.wpe-list-state-leave-active {
  transition: opacity var(--duration-base) ease;
}

.wpe-list-state-enter-from {
  opacity: 0;
}

.wpe-list-state-leave-to {
  opacity: 0;
}

.wpe-tree-swap-enter-active,
.wpe-tree-swap-leave-active {
  transition: opacity var(--duration-base) ease, transform var(--duration-base) ease;
}

.wpe-state-enter-active,
.wpe-state-leave-active {
  transition: opacity var(--duration-fast) ease;
}

.wpe-state-enter-from,
.wpe-state-leave-to {
  opacity: 0;
}

.wpe-tree-swap-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.wpe-tree-swap-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.wpe-node-enter-active {
  transition: opacity var(--duration-slow) ease, transform var(--duration-slow) cubic-bezier(0.16, 1, 0.3, 1);
}

.wpe-node-leave-active {
  transition: opacity var(--duration-fast) ease;
}

.wpe-node-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}

.wpe-node-leave-to {
  opacity: 0;
}

.wpe-node-move {
  transition: transform var(--duration-slow) cubic-bezier(0.16, 1, 0.3, 1);
}

.wpe-inspector-slot {
  flex: 0 0 0;
  min-height: 0;
  overflow: hidden;
  transition: flex-basis var(--duration-base) cubic-bezier(0.2, 0.8, 0.2, 1);
}

.wpe-inspector-slot.is-open {
  flex-basis: var(--wpe-inspector-height);
}

.wpe-inspector-enter-active,
.wpe-inspector-leave-active {
  transition:
    opacity 190ms ease,
    transform 190ms cubic-bezier(0.2, 0.8, 0.2, 1);
  pointer-events: none;
}

.wpe-inspector-enter-from,
.wpe-inspector-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

@media (prefers-reduced-motion: reduce) {
  .wpe-running-dot {
    animation: none;
  }

  .wpe-summary,
  .wpe-chip,
  .wpe-inspector-slot,
  .wpe-list-state-enter-active,
  .wpe-list-state-leave-active,
  .wpe-node-enter-active,
  .wpe-node-leave-active,
 .wpe-node-move,
 .wpe-tree-swap-enter-active,
 .wpe-tree-swap-leave-active,
  .wpe-state-enter-active,
  .wpe-state-leave-active,
 .wpe-inspector-enter-active,
  .wpe-inspector-leave-active {
    transition-duration: 1ms;
  }

  .wpe-list-state-enter-from,
  .wpe-list-state-leave-to,
  .wpe-tree-swap-enter-from,
  .wpe-tree-swap-leave-to,
  .wpe-node-enter-from,
  .wpe-node-leave-to {
    transform: none;
  }
}
</style>
