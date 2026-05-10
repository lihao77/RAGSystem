<template>
  <div class="wpe-root">
    <div class="wpe-header">
      <div class="wpe-heading">
        <span class="wpe-title">执行过程</span>
        <span class="wpe-summary">{{ summaryText }}</span>
      </div>
      <div class="wpe-meta">
        <button
          v-if="stats.running > 0"
          type="button"
          class="wpe-chip chip-running"
          title="定位运行中步骤"
          @click="focusRunningNode"
        >
          <span class="wpe-running-dot"></span>
          {{ stats.running }}
        </button>
        <button
          v-if="stats.error > 0"
          type="button"
          class="wpe-chip chip-error"
          title="定位失败步骤"
          @click="focusErrorNode"
        >{{ stats.error }} 失败</button>
        <span v-else-if="stats.success > 0" class="wpe-chip chip-success">{{ stats.success }} 完成</span>
      </div>
    </div>
    <Transition name="wpe-focus">
      <button
        v-if="visibleFocusNode"
        type="button"
        class="wpe-focus-strip"
        :class="`status-${normalizeStatus(visibleFocusNode.status)}`"
        title="定位当前关注步骤"
        @click="focusNodeInList(visibleFocusNode)"
      >
        <span class="wpe-focus-dot" aria-hidden="true"></span>
        <span class="wpe-focus-label">{{ focusStripLabel }}</span>
        <span class="wpe-focus-title">{{ focusStripTitle }}</span>
      </button>
    </Transition>

    <Transition name="wpe-list-state" mode="out-in">
      <div v-if="nodes.length === 0" key="empty" class="wpe-empty">
        <span class="wpe-empty-mark" aria-hidden="true"></span>
        <span>{{ running ? '等待第一步执行' : '暂无执行过程' }}</span>
      </div>
      <div v-else key="list" class="wpe-list" ref="listRef">
        <TransitionGroup name="wpe-node" tag="div" class="wpe-node-stack">
          <ExecutionTimelineNode
            v-for="(node, i) in nodes"
            :key="nodeKey(node, i)"
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

    <Transition name="wpe-inspector">
      <div v-if="selectedNode" class="wpe-inspector">
      <div class="wpe-inspector-header">
        <div class="wpe-inspector-title">
          <span class="wpe-inspector-kicker">{{ inspectorTypeLabel }}</span>
          <span class="wpe-inspector-name">{{ inspectorTitle }}</span>
        </div>
        <button type="button" class="wpe-inspector-close" title="关闭详情" @click="selectedNode = null">
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div class="wpe-inspector-body">
        <section v-if="selectedInspectorMeta.length || selectedSummarySections.length || selectedNode.ctx?.max > 0" class="wpe-inspector-section">
          <div class="wpe-section-heading heading-summary">
            <span class="wpe-section-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20">
                <path d="M4 5.8C4 4.8 4.8 4 5.8 4h8.4c1 0 1.8.8 1.8 1.8v8.4c0 1-.8 1.8-1.8 1.8H5.8c-1 0-1.8-.8-1.8-1.8V5.8Z" />
                <path d="M7 7.5h6" />
                <path d="M7 10h6" />
                <path d="M7 12.5h3.5" />
              </svg>
            </span>
            <span>摘要</span>
          </div>
          <div v-if="selectedInspectorMeta.length" class="wpe-meta-grid">
            <div
              v-for="item in selectedInspectorMeta"
              :key="item.label"
              class="wpe-meta-item"
              :class="metaItemClass(item)"
              :title="`${item.label}: ${item.value}`"
            >
              <span class="wpe-meta-label">{{ item.label }}</span>
              <span class="wpe-meta-value">{{ item.value }}</span>
            </div>
          </div>
          <div v-for="section in selectedSummarySections" :key="section.id" class="wpe-detail-block">
            <div class="wpe-detail-label">{{ section.label }}</div>
            <div class="wpe-detail-text">{{ section.text }}</div>
          </div>
          <div v-if="selectedNode.ctx?.max > 0" class="wpe-context">
            <div class="wpe-context-copy">
              <span>上下文</span>
              <span>{{ selectedCtxPercent }}%</span>
            </div>
            <div class="wpe-context-track">
              <span class="wpe-context-fill" :style="{ width: selectedCtxPercent + '%' }"></span>
            </div>
          </div>
        </section>

        <section v-if="selectedInputSections.length" class="wpe-inspector-section">
          <div class="wpe-section-heading heading-input">
            <span class="wpe-section-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20">
                <path d="M4 10h8.5" />
                <path d="m9 6.5 3.5 3.5L9 13.5" />
                <path d="M14 4.5h1.2c.9 0 1.6.7 1.6 1.6v7.8c0 .9-.7 1.6-1.6 1.6H14" />
              </svg>
            </span>
            <span>输入</span>
          </div>
          <div v-for="section in selectedInputSections" :key="section.id" class="wpe-detail-block">
            <div class="wpe-detail-label">{{ section.label }}</div>
            <div v-if="section.kind === 'code'" class="wpe-code-wrap">
              <button
                type="button"
                class="wpe-copy-btn"
                :title="copiedSectionId === section.id ? '已复制' : '复制'"
                @click="copySectionText(section)"
              >
                <svg v-if="copiedSectionId === section.id" viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
                  <path d="m4.5 10.5 3.2 3.2 7.8-8.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg v-else viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
                  <rect x="7" y="7" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
                  <path d="M4 12V5.8C4 4.8 4.8 4 5.8 4H12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </button>
              <pre class="wpe-code">{{ section.text }}</pre>
            </div>
            <div v-else class="wpe-detail-text">{{ section.text }}</div>
            <div v-if="section.options?.length" class="wpe-options">
              <span v-for="option in section.options" :key="option" class="wpe-option">{{ option }}</span>
            </div>
          </div>
        </section>

        <section v-if="selectedOutputSections.length" class="wpe-inspector-section">
          <div class="wpe-section-heading heading-output">
            <span class="wpe-section-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20">
                <path d="M4.5 5.5h11v5h-11z" />
                <path d="M6 13.5h8" />
                <path d="M8 16h4" />
                <path d="M7.5 8h5" />
              </svg>
            </span>
            <span>输出</span>
          </div>
          <div v-for="section in selectedOutputSections" :key="section.id" class="wpe-detail-block">
            <div class="wpe-detail-label">{{ section.label }}</div>
            <div v-if="section.kind === 'code'" class="wpe-code-wrap">
              <button
                type="button"
                class="wpe-copy-btn"
                :title="copiedSectionId === section.id ? '已复制' : '复制'"
                @click="copySectionText(section)"
              >
                <svg v-if="copiedSectionId === section.id" viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
                  <path d="m4.5 10.5 3.2 3.2 7.8-8.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg v-else viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
                  <rect x="7" y="7" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
                  <path d="M4 12V5.8C4 4.8 4.8 4 5.8 4H12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </button>
              <pre class="wpe-code result">{{ section.text }}</pre>
            </div>
            <div v-else class="wpe-detail-text" :class="{ muted: section.muted }">{{ section.text }}</div>
          </div>
        </section>
      </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, ref, watch, nextTick, onUnmounted } from 'vue'
import { buildExecutionTree } from '../../utils/executionTreeBuilder'
import {
  formatToolContent,
  getToolDisplayName as resolveToolDisplayName,
  getToolInputSections as resolveToolInputSections,
  getToolInspectorLabel as resolveToolInspectorLabel,
  getToolInspectorMeta as resolveToolInspectorMeta,
  getToolOutputSections as resolveToolOutputSections,
  getToolSummarySections as resolveToolSummarySections,
  hasToolArguments,
  parseToolPayload,
} from '../../utils/toolPresentation'
import ExecutionTimelineNode from './ExecutionTimelineNode.vue'

const props = defineProps({
  executionSteps: { type: Array, default: () => [] },
  subtasks: { type: Array, default: () => [] },
  running: { type: Boolean, default: false },
  sessionId: { type: String, default: '' },
})

const listRef = ref(null)
const selectedNode = ref(null)
const copiedSectionId = ref('')
let copiedResetTimer = null
const nodes = computed(() => buildExecutionTree(props.executionSteps, props.subtasks))
const flatNodes = computed(() => flattenNodes(nodes.value))
const focusNode = computed(() => findFocusNode(flatNodes.value))
const visibleFocusNode = computed(() => shouldShowFocusStrip(focusNode.value) ? focusNode.value : null)
const focusKey = computed(() => focusNode.value ? getNodeKey(focusNode.value) : '')
const selectedKey = computed(() => selectedNode.value ? getNodeKey(selectedNode.value) : '')

const selectedToolPayload = computed(() => selectedNode.value?.type === 'tool_call' ? parseToolPayload(selectedNode.value) : null)
const selectedPreviewResult = computed(() => selectedToolPayload.value?.preview ?? selectedNode.value?.result_preview ?? selectedNode.value?.result ?? '')
const selectedArguments = computed(() => selectedToolPayload.value?.args || {})
const hasSelectedArguments = computed(() => selectedNode.value?.type === 'tool_call' ? hasToolArguments(selectedNode.value) : false)
const formattedSelectedArguments = computed(() => formatToolContent(hasSelectedArguments.value ? selectedArguments.value : selectedNode.value?.arguments, 1600))
const formattedSelectedResult = computed(() => formatToolContent(selectedPreviewResult.value, 1600))
const selectedCtxPercent = computed(() => {
  const ctx = selectedNode.value?.ctx
  if (!ctx?.max) return 0
  return Math.min(100, Math.round((ctx.used / ctx.max) * 100))
})
const selectedStatusLabel = computed(() => {
  const label = {
    running: '执行中',
    success: '完成',
    error: '失败',
    stopped: '已停止',
    pending: '等待',
  }
  return label[normalizeStatus(selectedNode.value?.status)] || selectedNode.value?.status || '未知'
})
const selectedElapsedLabel = computed(() => formatElapsed(selectedNode.value?.elapsed_time))
const selectedInspectorMeta = computed(() => {
  const node = selectedNode.value
  if (!node) return []
  const meta = [{ label: '状态', value: selectedStatusLabel.value }]
  if (selectedElapsedLabel.value) meta.push({ label: '耗时', value: selectedElapsedLabel.value })
  if (node.type === 'agent_call') {
    const agent = node.agent_display_name || node.agent_name || node.agent
    if (agent) meta.push({ label: 'Agent', value: agent })
  }
  if (node.type === 'tool_call' && node.tool_name) meta.push({ label: '工具', value: node.tool_name })
  if (node.type === 'tool_call') {
    meta.push(...resolveToolInspectorMeta(node))
  }
  if (node.type === 'thought' && node.round) meta.push({ label: '轮次', value: String(node.round) })
  return dedupeMeta(meta).slice(0, 10)
})
const selectedSummarySections = computed(() => {
  const node = selectedNode.value
  if (!node) return []
  if (node.type === 'agent_call' && node.description) {
    return [{ id: 'summary-agent-task', label: '任务', text: node.description }]
  }
  if (node.type === 'thought') {
    const text = node.intent || node.thought || node.thinking || node.description || inspectorTitle.value
    return text ? [{ id: 'summary-thought', label: '内容', text }] : []
  }
  if (node.type !== 'tool_call') {
    const text = node.description || inspectorTitle.value
    return text ? [{ id: 'summary-content', label: '内容', text }] : []
  }
  return resolveToolSummarySections(node)
})
const selectedInputSections = computed(() => {
  const node = selectedNode.value
  if (!node || node.type !== 'tool_call') return []
  const specialized = resolveToolInputSections(node)
  if (specialized.length) return specialized
  if (!hasSelectedArguments.value) return []
  return [{ id: 'input-args', label: '参数', text: formattedSelectedArguments.value, kind: 'code' }]
})
const selectedOutputSections = computed(() => {
  const node = selectedNode.value
  if (!node) return []
  if (node.type === 'agent_call' && node.result_summary) {
    return [{ id: 'output-agent-result', label: '结果', text: node.result_summary }]
  }
  if (node.type !== 'tool_call') return []
  const specialized = resolveToolOutputSections(node)
  if (specialized.length) return specialized
  if (!selectedPreviewResult.value) return []
  return [{ id: 'output-result', label: '执行结果', text: formattedSelectedResult.value, kind: 'code' }]
})
const inspectorTypeLabel = computed(() => {
  if (!selectedNode.value) return ''
  if (selectedNode.value.type === 'agent_call') return 'Agent 详情'
  if (selectedNode.value.type === 'tool_call') return resolveToolInspectorLabel(selectedNode.value.tool_name)
  if (selectedNode.value.type === 'thought') return selectedNode.value.round ? `轮次 ${selectedNode.value.round}` : '思考详情'
  return '执行详情'
})
const inspectorTitle = computed(() => {
  const node = selectedNode.value
  if (!node) return ''
  if (node.type === 'agent_call') return node.agent_display_name || node.agent_name || node.description || 'Agent'
  if (node.type === 'tool_call') return resolveToolDisplayName(node)
  return node.intent || node.thought || node.thinking || node.description || '执行步骤'
})
const focusStripLabel = computed(() => {
  if (!visibleFocusNode.value) return ''
  const status = normalizeStatus(visibleFocusNode.value.status)
  if (status === 'error') return '失败'
  if (status === 'running') return '当前'
  if (visibleFocusNode.value.tool_name === 'request_user_input') return '待输入'
  return '最新'
})
const focusStripTitle = computed(() => getNodeTitle(visibleFocusNode.value))

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
  const shouldFollow = !listRef.value || isListNearBottom(listRef.value)
  await nextTick()
  const el = listRef.value
  if (el && shouldFollow) el.scrollTop = el.scrollHeight
})

watch(focusNode, (node) => {
  if (!selectedNode.value && node) {
    selectedNode.value = node
  }
})

onUnmounted(() => {
  if (copiedResetTimer) clearTimeout(copiedResetTimer)
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
  if (status === 'cancelled' || status === 'stopped') return 'stopped'
  if (status === 'running') return 'running'
  return status || 'pending'
}

function formatElapsed(value) {
  if (value === null || value === undefined || value === '') return ''
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))}ms`
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m${rest}s`
}

async function copyToClipboard(text) {
  const value = String(text || '')
  if (!value) return false
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function' &&
      typeof window !== 'undefined' &&
      window.isSecureContext
    ) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Fall through to the textarea fallback.
  }

  if (typeof document === 'undefined') return false
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return Boolean(document.execCommand && document.execCommand('copy'))
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}

function nodeKey(node, index) {
  return node.call_id || node.task_id || `${node.type}-${node.round || ''}-${index}`
}

function getNodeKey(node) {
  if (!node) return ''
  if (node.call_id) return `call:${node.call_id}`
  if (node.task_id) return `task:${node.task_id}`
  const identity = node.tool_name || node.agent_name || node.agent || node.agent_display_name || node.intent || node.description || ''
  return `${node.type || 'node'}:${node.round || ''}:${String(identity).slice(0, 80)}`
}

function selectNode(node) {
  selectedNode.value = node
}

async function copySectionText(section) {
  const text = String(section?.text || '')
  if (!text) return
  const ok = await copyToClipboard(text)
  if (!ok) return
  copiedSectionId.value = section.id
  if (copiedResetTimer) clearTimeout(copiedResetTimer)
  copiedResetTimer = setTimeout(() => {
    if (copiedSectionId.value === section.id) copiedSectionId.value = ''
  }, 1200)
}

async function focusNodeInList(node) {
  if (!node) return
  selectedNode.value = node
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

function findLastByStatus(status) {
  for (let i = flatNodes.value.length - 1; i >= 0; i -= 1) {
    if (normalizeStatus(flatNodes.value[i]?.status) === status) return flatNodes.value[i]
  }
  return null
}

function shouldShowFocusStrip(node) {
  if (!node) return false
  const status = normalizeStatus(node.status)
  return status === 'running' || status === 'error' || node.tool_name === 'request_user_input'
}

function scrollNodeIntoView(key) {
  if (!key || !listRef.value) return
  const selectorKey = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/"/g, '\\"')
  const target = listRef.value.querySelector(`[data-node-key="${selectorKey}"]`)
  if (!target) return
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' })
}

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
    if (items[i]?.tool_name === 'request_user_input') return items[i]
  }
  return items[items.length - 1] || null
}

function getNodeTitle(node) {
  if (!node) return ''
  if (node.type === 'agent_call') {
    return node.description || node.result_summary || node.agent_display_name || node.agent_name || 'Agent'
  }
  if (node.type === 'tool_call') {
    return resolveToolDisplayName(node)
  }
  return node.intent || node.thought || node.thinking || node.description || '执行步骤'
}

function metaItemClass(item) {
  if (item?.label !== '状态') return ''
  const value = String(item.value || '')
  if (value.includes('失败')) return 'meta-status-error'
  if (value.includes('完成')) return 'meta-status-success'
  if (value.includes('执行') || value.includes('等待')) return 'meta-status-running'
  if (value.includes('停止')) return 'meta-status-stopped'
  return ''
}

function dedupeMeta(items) {
  const seen = new Set()
  return items.filter(item => {
    const key = item.label
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
  transition: color var(--transition-fast);
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
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.42);
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

.wpe-focus-strip {
  margin: 0 14px 10px;
  min-height: 34px;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.3);
  color: var(--color-text-secondary);
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast),
    box-shadow var(--transition-fast);
}

.wpe-focus-strip:hover {
  border-color: var(--color-border-hover);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.44);
}

.wpe-focus-strip.status-running {
  border-color: rgba(var(--color-brand-accent-rgb), 0.24);
  background: rgba(var(--color-brand-accent-rgb), 0.08);
  box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.04);
}

.wpe-focus-strip.status-running:hover {
  border-color: rgba(var(--color-brand-accent-rgb), 0.34);
  background: rgba(var(--color-brand-accent-rgb), 0.12);
}

.wpe-focus-strip.status-success {
  border-color: rgba(var(--color-success-rgb), 0.24);
  background: rgba(var(--color-success-rgb), 0.08);
  box-shadow: 0 0 0 3px rgba(var(--color-success-rgb), 0.035);
}

.wpe-focus-strip.status-success:hover {
  border-color: rgba(var(--color-success-rgb), 0.32);
  background: rgba(var(--color-success-rgb), 0.12);
}

.wpe-focus-strip.status-error {
  border-color: rgba(var(--color-error-rgb), 0.28);
  background: rgba(var(--color-error-rgb), 0.08);
  box-shadow: 0 0 0 3px rgba(var(--color-error-rgb), 0.04);
}

.wpe-focus-strip.status-error:hover {
  border-color: rgba(var(--color-error-rgb), 0.38);
  background: rgba(var(--color-error-rgb), 0.12);
}

.wpe-focus-strip.status-stopped {
  border-color: rgba(var(--color-warning-rgb), 0.26);
  background: rgba(var(--color-warning-rgb), 0.08);
  box-shadow: 0 0 0 3px rgba(var(--color-warning-rgb), 0.035);
}

.wpe-focus-strip.status-stopped:hover {
  border-color: rgba(var(--color-warning-rgb), 0.36);
  background: rgba(var(--color-warning-rgb), 0.12);
}

.wpe-focus-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--color-text-muted);
}

.wpe-focus-strip.status-running .wpe-focus-dot {
  background: var(--color-brand-accent);
  animation: pulse 1.5s ease-in-out infinite;
}

.wpe-focus-strip.status-error .wpe-focus-dot {
  background: var(--color-error);
}

.wpe-focus-strip.status-success .wpe-focus-dot {
  background: var(--color-success);
}

.wpe-focus-strip.status-stopped .wpe-focus-dot {
  background: var(--color-warning);
}

.wpe-focus-label {
  font-size: 11px;
  line-height: 1;
  font-weight: 700;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.wpe-focus-title {
  min-width: 0;
  font-size: 12px;
  line-height: 1.35;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  padding: 0 12px 12px 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
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

.wpe-node-stack:not(:has(> .etn + .etn)):not(:has(> .etn--has-children))::before {
  display: none;
}

.wpe-list::-webkit-scrollbar { width: 3px; }
.wpe-list::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 2px;
}

.wpe-inspector {
  flex-shrink: 0;
  max-height: min(52%, 520px);
  min-height: 180px;
  border-top: 1px solid var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.36);
  display: flex;
  flex-direction: column;
  transform-origin: bottom;
  will-change: transform, opacity;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025);
}

.wpe-inspector-header {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px 9px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.52);
  flex-shrink: 0;
}

.wpe-inspector-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wpe-inspector-kicker {
  font-size: 10px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--color-text-muted);
}

.wpe-inspector-name {
  font-size: 12px;
  line-height: 1.35;
  font-weight: 650;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wpe-inspector-close {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.wpe-inspector-close:hover {
  background: var(--color-hover-overlay);
  color: var(--color-text-primary);
}

.wpe-inspector-body {
  min-height: 0;
  overflow: auto;
  padding: 10px 14px 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
}

.wpe-inspector-body::-webkit-scrollbar {
  width: 4px;
}

.wpe-inspector-body::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: var(--radius-full);
}

.wpe-inspector-section {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  padding-top: 12px;
  border-top: 1px solid color-mix(in srgb, var(--color-border) 68%, transparent);
}

.wpe-inspector-section:first-child {
  padding-top: 0;
  border-top: 0;
}

.wpe-section-heading {
  --section-tone: var(--color-text-muted);
  --section-tone-rgb: var(--color-text-muted-rgb, 142, 142, 147);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--color-text-muted);
  text-transform: none;
}

.heading-summary {
  --section-tone: var(--color-brand-accent);
  --section-tone-rgb: var(--color-brand-accent-rgb);
}

.heading-input {
  --section-tone: var(--color-warning);
  --section-tone-rgb: var(--color-warning-rgb);
}

.heading-output {
  --section-tone: var(--color-success);
  --section-tone-rgb: var(--color-success-rgb);
}

.wpe-section-icon {
  width: 18px;
  height: 18px;
  border-radius: 6px;
  border: 1px solid rgba(var(--section-tone-rgb), 0.24);
  background: rgba(var(--section-tone-rgb), 0.08);
  color: var(--section-tone);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.wpe-section-icon svg {
  width: 12px;
  height: 12px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.wpe-meta-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.wpe-meta-item {
  --meta-tone: var(--color-text-muted);
  --meta-tone-rgb: var(--color-bg-elevated-rgb, 28, 28, 30);
  max-width: 100%;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.3);
  color: var(--color-text-secondary);
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.wpe-meta-label {
  font-size: 10px;
  line-height: 1;
  font-weight: 700;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.wpe-meta-value {
  min-width: 0;
  font-size: 11px;
  line-height: 1;
  color: currentColor;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wpe-meta-item.meta-status-success {
  --meta-tone: var(--color-success);
  --meta-tone-rgb: var(--color-success-rgb);
}

.wpe-meta-item.meta-status-running {
  --meta-tone: var(--color-brand-accent);
  --meta-tone-rgb: var(--color-brand-accent-rgb);
}

.wpe-meta-item.meta-status-error {
  --meta-tone: var(--color-error);
  --meta-tone-rgb: var(--color-error-rgb);
}

.wpe-meta-item.meta-status-stopped {
  --meta-tone: var(--color-warning);
  --meta-tone-rgb: var(--color-warning-rgb);
}

.wpe-meta-item[class*="meta-status-"] {
  border-color: rgba(var(--meta-tone-rgb), 0.24);
  background: rgba(var(--meta-tone-rgb), 0.08);
  color: var(--meta-tone);
}

.wpe-meta-item[class*="meta-status-"] .wpe-meta-label {
  color: var(--meta-tone);
}

.wpe-detail-block {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  padding: 9px;
  border: 1px solid var(--color-border);
  border-color: color-mix(in srgb, var(--color-border) 72%, transparent);
  border-radius: 6px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.16);
}

.wpe-detail-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--color-text-muted);
}

.wpe-detail-label::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--color-border-hover);
  flex-shrink: 0;
}

.wpe-detail-text {
  max-height: 132px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.55;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
}

.wpe-detail-text::-webkit-scrollbar,
.wpe-code::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}

.wpe-detail-text::-webkit-scrollbar-thumb,
.wpe-code::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: var(--radius-full);
}

.wpe-detail-text.muted,
.muted {
  color: var(--color-text-muted);
}

.wpe-code-wrap {
  position: relative;
  min-width: 0;
}

.wpe-copy-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 1;
  width: 24px;
  height: 24px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.82);
  color: var(--color-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.wpe-copy-btn:hover {
  border-color: var(--color-border-hover);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.96);
}

.wpe-code {
  margin: 0;
  max-height: 210px;
  overflow: auto;
  padding: 9px 38px 9px 10px;
  border: 1px solid var(--color-border);
  border-color: color-mix(in srgb, var(--color-border) 72%, transparent);
  border-radius: 6px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.28);
  color: var(--color-text-secondary);
  font: 11px/1.5 var(--font-mono);
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
}

.wpe-code.result {
  color: var(--color-result-text);
  background: var(--color-result-bg);
  border-color: var(--color-result-border);
}

.wpe-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.wpe-option {
  max-width: 100%;
  padding: 3px 7px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.28);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wpe-context {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px;
  border: 1px solid var(--color-border);
  border-color: color-mix(in srgb, var(--color-border) 72%, transparent);
  border-radius: 6px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.16);
}

.wpe-context-copy {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  color: var(--color-text-muted);
}

.wpe-context-track {
  height: 4px;
  border-radius: var(--radius-full);
  overflow: hidden;
  background: var(--color-border);
}

.wpe-context-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-brand-accent);
  transition: width 420ms ease;
}

.wpe-focus-enter-active,
.wpe-focus-leave-active {
  transition: opacity 180ms ease, transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.wpe-focus-enter-from,
.wpe-focus-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.wpe-list-state-enter-active,
.wpe-list-state-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}

.wpe-list-state-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.wpe-list-state-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.wpe-node-enter-active,
.wpe-node-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}

.wpe-node-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.wpe-node-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.wpe-node-move {
  transition: transform 180ms ease;
}

.wpe-inspector-enter-active,
.wpe-inspector-leave-active {
  transition:
    opacity 190ms ease,
    transform 190ms cubic-bezier(0.2, 0.8, 0.2, 1),
    max-height 190ms ease,
    min-height 190ms ease;
  overflow: hidden;
}

.wpe-inspector-enter-from,
.wpe-inspector-leave-to {
  opacity: 0;
  transform: translateY(12px);
  max-height: 0;
  min-height: 0;
}

@media (prefers-reduced-motion: reduce) {
  .wpe-running-dot,
  .wpe-focus-strip.status-running .wpe-focus-dot {
    animation: none;
  }

  .wpe-summary,
  .wpe-chip,
  .wpe-focus-strip,
  .wpe-inspector-close,
  .wpe-context-fill,
  .wpe-focus-enter-active,
  .wpe-focus-leave-active,
  .wpe-list-state-enter-active,
  .wpe-list-state-leave-active,
  .wpe-node-enter-active,
  .wpe-node-leave-active,
  .wpe-node-move,
  .wpe-inspector-enter-active,
  .wpe-inspector-leave-active {
    transition-duration: 1ms;
  }

  .wpe-focus-enter-from,
  .wpe-focus-leave-to,
  .wpe-list-state-enter-from,
  .wpe-list-state-leave-to,
  .wpe-node-enter-from,
  .wpe-node-leave-to,
  .wpe-inspector-enter-from,
  .wpe-inspector-leave-to {
    transform: none;
  }
}
</style>
