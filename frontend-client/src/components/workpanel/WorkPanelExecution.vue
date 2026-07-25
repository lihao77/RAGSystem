<template>
  <div
    ref="rootRef"
    :class="cn('wpe-root', { 'is-resizing-inspector': isInspectorResizing })"
    :style="inspectorStyle"
  >
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
        <EmptyState v-if="!executionView.hasNodes" row :title="executionView.emptyText" key="empty" class="wpe-empty-host" />
        <div v-else class="wpe-list" key="list">
          <Transition name="wpe-tree-swap" mode="out-in" appear>
            <DynamicScroller
              v-if="shouldVirtualize"
              :key="`virtual-${messageKey}`"
              ref="listRef"
              :class="cn('wpe-scroll', 'wpe-scroll--virtual', { 'has-return-current': showReturnToCurrent })"
              :items="virtualNodes"
              :min-item-size="34"
              :buffer="240"
              key-field="key"
              list-class="wpe-node-stack"
              @scroll.passive="handleListScroll"
            >
              <template #default="{ item, index, active }">
                <DynamicScrollerItem
                  :item="item"
                  :active="active"
                  :data-index="index"
                  :size-dependencies="[item.measureKey, item.layoutVersion]"
                >
                  <div class="wpe-virtual-item">
                    <ExecutionNodeRows
                      :nodes="[item.node]"
                      :depth="0"
                      :session-id="sessionId"
                      :focus-key="focusKey"
                      :selected-key="selectedKey"
                      :expanded-groups="expandedGroups"
                      @inspect="selectNode"
                      @toggle-group="toggleGroup"
                      @layout-change="handleNodeLayoutChange(item.key)"
                    />
                  </div>
                </DynamicScrollerItem>
              </template>
            </DynamicScroller>

            <div
              v-else
              :key="messageKey"
              ref="listRef"
              :class="cn('wpe-scroll', { 'has-return-current': showReturnToCurrent })"
              @scroll.passive="handleListScroll"
            >
              <TransitionGroup name="wpe-node" tag="div" class="wpe-node-stack">
                <div v-for="(node, i) in executionView.nodes" :key="timelineNodeKey(node, i)" class="wpe-top-item">
                  <ExecutionNodeRows
                    :nodes="[node]"
                    :depth="0"
                    :session-id="sessionId"
                    :focus-key="focusKey"
                    :selected-key="selectedKey"
                    :expanded-groups="expandedGroups"
                    @inspect="selectNode"
                    @toggle-group="toggleGroup"
                  />
                </div>
              </TransitionGroup>
            </div>
          </Transition>
        </div>
      </Transition>

      <Transition name="wpe-return-current">
        <Button
          v-if="showReturnToCurrent"
          class="wpe-return-current"
          variant="secondary"
          size="action"
          type="button"
          title="定位正在执行的步骤"
          @click="returnToCurrentStep"
        >
          <LocateFixed data-icon="inline-start" />
          当前步骤
        </Button>
      </Transition>
    </div>

    <div class="wpe-inspector-slot" :class="{ 'is-open': selectedNode }">
      <div
        v-if="selectedNode"
        class="wpe-inspector-resize"
        role="separator"
        tabindex="0"
        aria-label="调整执行详情高度"
        aria-orientation="horizontal"
        :aria-valuemin="INSPECTOR_MIN_HEIGHT"
        :aria-valuemax="inspectorMaxHeight"
        :aria-valuenow="Math.round(inspectorHeight)"
        title="拖动调整详情高度，双击恢复默认"
        @dblclick="resetInspectorHeight"
        @keydown="handleInspectorResizeKeydown"
        @pointerdown="startInspectorResize"
      >
        <span aria-hidden="true"></span>
      </div>
      <Transition name="wpe-inspector">
        <WorkPanelInspector v-if="selectedNode" :node="selectedNode" @close="clearSelectedNode" />
      </Transition>
    </div>
  </div>
</template>

<script setup>
import { LocateFixed } from 'lucide-vue-next'
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/index.css'
import { cn } from '@/lib/utils'
import { buildExecutionTree } from '../../utils/executionTreeBuilder'
import {
  buildActionRows,
  flattenExecutionNodes as flattenNodes,
  getExecutionNodeKey as getNodeKey,
  normalizeExecutionStatus as normalizeStatus,
} from '../../utils/executionTreePresentation'
import ExecutionNodeRows from './ExecutionNodeRows.vue'
import WorkPanelInspector from './WorkPanelInspector.vue'
import EmptyState from '../EmptyState.vue'
import { Button } from '../ui/button'

const props = defineProps({
  executionTree: { type: Object, default: () => ({ root: null, steps: [] }) },
  injections: { type: Array, default: () => [] },
  running: { type: Boolean, default: false },
  sessionId: { type: String, default: '' },
  messageKey: { type: String, default: '' },
})

const listRef = ref(null)
const rootRef = ref(null)
const selectedNodeKey = ref('')
const showReturnToCurrent = ref(false)
const inspectorHeight = ref(0)
const isInspectorResizing = ref(false)
const rootHeight = ref(0)
const virtualLayoutVersions = ref({})
// 折叠组展开态:集中持有(跨层级选中组内节点时需统一展开),key 为组 id。
const expandedGroups = ref({})
const VIRTUALIZE_NODE_THRESHOLD = 80
const VIRTUALIZE_BRANCH_THRESHOLD = 4
const INSPECTOR_MIN_HEIGHT = 190
const INSPECTOR_LIST_MIN_HEIGHT = 160
const INSPECTOR_MAX_HEIGHT = 560
const INSPECTOR_KEY_STEP = 24
let inspectorResizeStartY = 0
let inspectorResizeStartHeight = 0
let rootResizeObserver = null
let selectionScrollTimer = null
const nodes = computed(() => buildExecutionTree(props.executionTree, props.injections))

const flatNodes = computed(() => flattenNodes(nodes.value))
const focusNode = computed(() => findFocusNode(flatNodes.value))
const focusKey = computed(() => focusNode.value ? getNodeKey(focusNode.value) : '')
const selectedNode = computed(() => findNodeByKey(flatNodes.value, selectedNodeKey.value))
const selectedKey = computed(() => selectedNodeKey.value)
const inspectorMaxHeight = computed(() => {
  if (!rootHeight.value) return 420
  return Math.max(INSPECTOR_MIN_HEIGHT, Math.min(INSPECTOR_MAX_HEIGHT, rootHeight.value - INSPECTOR_LIST_MIN_HEIGHT))
})
const inspectorStyle = computed(() => ({
  '--wpe-inspector-height': `${Math.round(inspectorHeight.value)}px`,
}))
const shouldVirtualize = computed(() => (
  flatNodes.value.length >= VIRTUALIZE_NODE_THRESHOLD
  && nodes.value.length >= VIRTUALIZE_BRANCH_THRESHOLD
))

// 组展开态签名:任一折叠组开合都变化,驱动虚拟滚动重新测量行高。
const groupExpandSignature = computed(() => (
  Object.keys(expandedGroups.value)
    .filter(id => expandedGroups.value[id])
    .sort()
    .join(',')
))
const virtualNodes = computed(() => nodes.value.map((node, index) => {
  const key = getNodeKey(node) || timelineNodeKey(node, index)
  return {
    key,
    node,
    layoutVersion: virtualLayoutVersions.value[key] || 0,
    measureKey: [
      node.status || '',
      node.children?.length || 0,
      node.description || '',
      node.result_summary || '',
      groupExpandSignature.value,
    ].join(':'),
  }
}))

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
  return parts.join(' · ')
}

const scrollSignature = computed(() => flatNodes.value.map((node, index) => [
  index,
  node.type,
  node.call_id || node.task_id || node.round || '',
  node.status || '',
  node.children?.length || 0,
].join(':')).join('|'))

watch(scrollSignature, async () => {
  if (!props.running) {
    showReturnToCurrent.value = false
    return
  }
  const shouldFollow = !getListElement() || isListNearBottom(getListElement())
  await nextTick()
  const el = getListElement()
  if (el && shouldFollow) {
    if (shouldVirtualize.value && listRef.value?.scrollToBottom) listRef.value.scrollToBottom()
    else el.scrollTop = el.scrollHeight
  }
  updateReturnToCurrentVisibility()
})

watch([focusKey, () => props.running], async () => {
  await nextTick()
  updateReturnToCurrentVisibility()
})

watch(selectedNode, (node) => {
  if (selectedNodeKey.value && !node) {
    clearSelectedNode()
  }
  if (node) initializeInspectorHeight()
})

watch(() => props.messageKey, () => {
  clearSelectedNode()
  showReturnToCurrent.value = false
  virtualLayoutVersions.value = {}
  expandedGroups.value = {}
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
  revealGroupContaining(key)
  selectedNodeKey.value = key
  await nextTick()
  scrollNodeIntoView(key)
  scheduleSelectionScrollCorrection(key)
}

function toggleGroup(groupId) {
  expandedGroups.value = {
    ...expandedGroups.value,
    [groupId]: !expandedGroups.value[groupId],
  }
}

// 选中组内节点时,先展开它所在的折叠组,确保 DOM 存在可被定位。
function revealGroupContaining(key) {
  if (!key) return
  walkLevel(nodes.value, key)
}

// 对每层 children 调 buildActionRows 找含目标 key 的组并展开;递归进有子树的节点。
function walkLevel(nodeList, key) {
  if (!Array.isArray(nodeList) || !nodeList.length) return
  buildActionRows(nodeList).forEach((row) => {
    if (row.kind === 'group') {
      if (row.nodes.some(n => getNodeKey(n) === key)) {
        const id = `${row.groupKey}:${getNodeKey(row.nodes[0])}`
        if (!expandedGroups.value[id]) {
          expandedGroups.value = { ...expandedGroups.value, [id]: true }
        }
      }
      return
    }
    if (row.node?.children?.length) walkLevel(row.node.children, key)
  })
}

function clearSelectedNode() {
  selectedNodeKey.value = ''
  if (selectionScrollTimer) {
    clearTimeout(selectionScrollTimer)
    selectionScrollTimer = null
  }
}

async function initializeInspectorHeight() {
  await nextTick()
  inspectorHeight.value = clampInspectorHeight(inspectorHeight.value || defaultInspectorHeight())
}

function defaultInspectorHeight() {
  if (!rootHeight.value) return 320
  return Math.round(rootHeight.value * 0.38)
}

function clampInspectorHeight(value) {
  return Math.min(inspectorMaxHeight.value, Math.max(INSPECTOR_MIN_HEIGHT, Number(value) || INSPECTOR_MIN_HEIGHT))
}

function startInspectorResize(event) {
  if (event.button !== 0) return
  event.preventDefault()
  inspectorResizeStartY = event.clientY
  inspectorResizeStartHeight = inspectorHeight.value
  isInspectorResizing.value = true
  window.addEventListener('pointermove', handleInspectorResizeMove)
  window.addEventListener('pointerup', stopInspectorResize, { once: true })
}

function handleInspectorResizeMove(event) {
  if (!isInspectorResizing.value) return
  inspectorHeight.value = clampInspectorHeight(inspectorResizeStartHeight + inspectorResizeStartY - event.clientY)
}

function stopInspectorResize() {
  isInspectorResizing.value = false
  window.removeEventListener('pointermove', handleInspectorResizeMove)
}

function resetInspectorHeight() {
  inspectorHeight.value = clampInspectorHeight(defaultInspectorHeight())
}

function handleInspectorResizeKeydown(event) {
  let nextHeight = null
  if (event.key === 'ArrowUp') nextHeight = inspectorHeight.value + INSPECTOR_KEY_STEP
  if (event.key === 'ArrowDown') nextHeight = inspectorHeight.value - INSPECTOR_KEY_STEP
  if (event.key === 'Home') nextHeight = INSPECTOR_MIN_HEIGHT
  if (event.key === 'End') nextHeight = inspectorMaxHeight.value
  if (nextHeight === null) return
  event.preventDefault()
  inspectorHeight.value = clampInspectorHeight(nextHeight)
}

async function focusNodeInList(node) {
  if (!node) return
  await nextTick()
  await scrollNodeIntoView(getNodeKey(node))
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

async function scrollNodeIntoView(key) {
  if (!key || !listRef.value) return
  if (shouldVirtualize.value) {
    const branchIndex = findVirtualBranchIndex(key)
    if (branchIndex >= 0) {
      listRef.value.scrollToItem(branchIndex)
      await nextTick()
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
  }
  const target = findNodeElement(key)
  const viewport = getListElement()
  if (!target || !viewport) return
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const viewportRect = viewport.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const viewportHeight = viewport.clientHeight
  const targetTop = viewport.scrollTop + targetRect.top - viewportRect.top
  const targetHeight = targetRect.height
  const nextTop = Math.max(0, targetTop - Math.max(0, (viewportHeight - targetHeight) / 2))
  viewport.scrollTo({ top: nextTop, behavior: reduceMotion ? 'auto' : 'smooth' })
}

function findNodeElement(key) {
  const viewport = getListElement()
  if (!key || !viewport) return null
  const selectorKey = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/"/g, '\\"')
  return viewport.querySelector(`[data-node-key="${selectorKey}"]`)
}

function getListElement() {
  return listRef.value?.$el || listRef.value || null
}

function findVirtualBranchIndex(key) {
  return nodes.value.findIndex(node => containsNodeKey(node, key))
}

function containsNodeKey(node, key) {
  if (!node || !key) return false
  if (getNodeKey(node) === key) return true
  return Array.isArray(node.children) && node.children.some(child => containsNodeKey(child, key))
}

function handleNodeLayoutChange(key) {
  virtualLayoutVersions.value = {
    ...virtualLayoutVersions.value,
    [key]: (virtualLayoutVersions.value[key] || 0) + 1,
  }
}

function handleListScroll() {
  updateReturnToCurrentVisibility()
}

function updateReturnToCurrentVisibility() {
  const viewport = getListElement()
  const target = findNodeElement(focusKey.value)
  if (!props.running || !viewport || !focusKey.value) {
    showReturnToCurrent.value = false
    return
  }
  if (!target) {
    showReturnToCurrent.value = shouldVirtualize.value
    return
  }
  const viewportRect = viewport.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const inset = 8
  showReturnToCurrent.value = targetRect.bottom < viewportRect.top + inset
    || targetRect.top > viewportRect.bottom - inset
}

async function returnToCurrentStep() {
  if (!focusNode.value) return
  await focusNodeInList(focusNode.value)
  showReturnToCurrent.value = false
}

function scheduleSelectionScrollCorrection(key) {
  if (selectionScrollTimer) clearTimeout(selectionScrollTimer)
  selectionScrollTimer = setTimeout(() => {
    if (selectedNodeKey.value === key) scrollNodeIntoView(key)
    selectionScrollTimer = null
  }, 220)
}

onMounted(() => {
  const updateRootHeight = () => {
    rootHeight.value = rootRef.value?.clientHeight || 0
    if (inspectorHeight.value) inspectorHeight.value = clampInspectorHeight(inspectorHeight.value)
  }
  updateRootHeight()
  if (typeof ResizeObserver !== 'undefined' && rootRef.value) {
    rootResizeObserver = new ResizeObserver(updateRootHeight)
    rootResizeObserver.observe(rootRef.value)
  }
})

onUnmounted(() => {
  if (selectionScrollTimer) clearTimeout(selectionScrollTimer)
  window.removeEventListener('pointermove', handleInspectorResizeMove)
  window.removeEventListener('pointerup', stopInspectorResize)
  rootResizeObserver?.disconnect()
})

function isListNearBottom(el) {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 36
}

function findFocusNode(items) {
  if (props.running) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (normalizeStatus(items[i]?.status) === 'running') return items[i]
    }
  }
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
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border-top: none;
  letter-spacing: 0;
  position: relative;
}

.wpe-root.is-resizing-inspector {
  cursor: row-resize;
  user-select: none;
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

.wpe-empty-host {
  margin: 0 14px;
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
  transition: padding-bottom var(--transition-fast);
}

.wpe-scroll.has-return-current {
  padding-bottom: 48px;
}

.wpe-scroll--virtual :deep(.wpe-node-stack) {
  position: relative;
  box-sizing: border-box;
  padding: 0 12px 48px 10px;
}

.wpe-scroll--virtual {
  padding: 0;
}

.wpe-scroll--virtual.has-return-current {
  padding-bottom: 0;
}

.wpe-virtual-item {
  padding-bottom: 2px;
}

.wpe-top-item + .wpe-top-item {
  margin-top: 2px;
}

.wpe-return-current {
  position: absolute;
  right: 14px;
  bottom: 12px;
  box-shadow: var(--shadow-md);
}

.wpe-return-current-enter-active,
.wpe-return-current-leave-active {
  transition: opacity var(--duration-fast) ease, transform var(--duration-fast) ease;
}

.wpe-return-current-enter-from,
.wpe-return-current-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.wpe-node-stack {
  position: relative;
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
  position: relative;
  overflow: hidden;
  transition: flex-basis var(--duration-base) cubic-bezier(0.2, 0.8, 0.2, 1);
}

.wpe-inspector-slot.is-open {
  flex-basis: var(--wpe-inspector-height);
}

.wpe-inspector-resize {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 3;
  height: 12px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 3px;
  cursor: row-resize;
  touch-action: none;
  outline: none;
}

.wpe-inspector-resize span {
  width: 34px;
  height: 3px;
  border-radius: var(--radius-full);
  background: var(--color-border-hover);
  opacity: 0.72;
  transition: width var(--transition-fast), background var(--transition-fast), opacity var(--transition-fast);
}

.wpe-inspector-resize:hover span,
.wpe-inspector-resize:focus-visible span,
.wpe-root.is-resizing-inspector .wpe-inspector-resize span {
  width: 48px;
  background: var(--color-brand-accent);
  opacity: 1;
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
  .wpe-scroll,
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
  .wpe-return-current-enter-active,
  .wpe-return-current-leave-active,
 .wpe-inspector-enter-active,
  .wpe-inspector-leave-active {
    transition-duration: 1ms;
  }

  .wpe-list-state-enter-from,
  .wpe-list-state-leave-to,
  .wpe-tree-swap-enter-from,
  .wpe-tree-swap-leave-to,
  .wpe-node-enter-from,
  .wpe-node-leave-to,
  .wpe-return-current-enter-from,
  .wpe-return-current-leave-to {
    transform: none;
  }
}
</style>
