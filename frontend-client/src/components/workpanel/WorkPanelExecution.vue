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
        :focus-key="focusKey"
        :selected-key="selectedKey"
        @inspect="selectNode"
      />
    </div>
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
        <template v-if="selectedNode.type === 'agent_call'">
          <div v-if="selectedNode.description" class="wpe-detail-block">
            <div class="wpe-detail-label">任务</div>
            <div class="wpe-detail-text">{{ selectedNode.description }}</div>
          </div>
          <div v-if="selectedNode.result_summary" class="wpe-detail-block">
            <div class="wpe-detail-label">结果</div>
            <div class="wpe-detail-text">{{ selectedNode.result_summary }}</div>
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
        </template>

        <template v-else-if="selectedNode.type === 'tool_call'">
          <template v-if="selectedNode.tool_name === 'request_user_input'">
            <div v-if="selectedNode.arguments?.prompt" class="wpe-detail-block">
              <div class="wpe-detail-label">智能体提问</div>
              <div class="wpe-detail-text">{{ selectedNode.arguments.prompt }}</div>
              <div v-if="Array.isArray(selectedNode.arguments?.options) && selectedNode.arguments.options.length > 0" class="wpe-options">
                <span v-for="option in selectedNode.arguments.options" :key="String(option)" class="wpe-option">{{ option }}</span>
              </div>
            </div>
            <div v-if="selectedPreviewResult && selectedPreviewResult !== '（已取消）'" class="wpe-detail-block">
              <div class="wpe-detail-label">用户回答</div>
              <div class="wpe-detail-text">{{ selectedPreviewResult }}</div>
            </div>
            <div v-else-if="normalizeStatus(selectedNode.status) === 'running'" class="wpe-detail-text muted">等待用户输入中</div>
          </template>

          <template v-else>
            <div v-if="hasSelectedArguments" class="wpe-detail-block">
              <div class="wpe-detail-label">输入参数</div>
              <pre class="wpe-code">{{ formattedSelectedArguments }}</pre>
            </div>
            <div v-if="selectedPreviewResult" class="wpe-detail-block">
              <div class="wpe-detail-label">执行结果</div>
              <pre class="wpe-code result">{{ formattedSelectedResult }}</pre>
            </div>
          </template>
        </template>

        <template v-else>
          <div class="wpe-detail-block">
            <div class="wpe-detail-label">内容</div>
            <div class="wpe-detail-text">{{ inspectorTitle }}</div>
          </div>
        </template>
      </div>
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
const selectedNode = ref(null)
const nodes = computed(() => buildExecutionTree(props.executionSteps, props.subtasks))
const flatNodes = computed(() => flattenNodes(nodes.value))
const focusNode = computed(() => findFocusNode(flatNodes.value))
const focusKey = computed(() => focusNode.value ? getNodeKey(focusNode.value) : '')
const selectedKey = computed(() => selectedNode.value ? getNodeKey(selectedNode.value) : '')

const selectedPreviewResult = computed(() => selectedNode.value?.result_preview ?? selectedNode.value?.result ?? '')
const hasSelectedArguments = computed(() => {
  const args = selectedNode.value?.arguments
  if (!args) return false
  if (typeof args === 'object') return Object.keys(args).length > 0
  return String(args).trim().length > 0
})
const formattedSelectedArguments = computed(() => formatContent(selectedNode.value?.arguments, 1600))
const formattedSelectedResult = computed(() => formatContent(selectedPreviewResult.value, 1600))
const selectedCtxPercent = computed(() => {
  const ctx = selectedNode.value?.ctx
  if (!ctx?.max) return 0
  return Math.min(100, Math.round((ctx.used / ctx.max) * 100))
})
const inspectorTypeLabel = computed(() => {
  if (!selectedNode.value) return ''
  if (selectedNode.value.type === 'agent_call') return 'Agent 详情'
  if (selectedNode.value.type === 'tool_call') return '工具详情'
  if (selectedNode.value.type === 'thought') return selectedNode.value.round ? `轮次 ${selectedNode.value.round}` : '思考详情'
  return '执行详情'
})
const inspectorTitle = computed(() => {
  const node = selectedNode.value
  if (!node) return ''
  if (node.type === 'agent_call') return node.agent_display_name || node.agent_name || node.description || 'Agent'
  if (node.type === 'tool_call') return getToolDisplayName(node)
  return node.intent || node.thought || node.thinking || node.description || '执行步骤'
})

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

watch(focusNode, (node) => {
  if (!selectedNode.value && node) {
    selectedNode.value = node
  }
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

function getToolDisplayName(node) {
  const name = node?.tool_name || ''
  if (name === 'request_user_input') return '请求用户输入'
  const args = node?.arguments || {}
  const skillNames = {
    activate_skill: `激活 ${args.skill_name || 'Skill'}`,
    load_skill_resource: `加载 ${args.skill_name || 'Skill'} 资源`,
    execute_skill_script: `执行 ${args.skill_name || 'Skill'} 脚本`,
    get_skill_info: `查询 ${args.skill_name || 'Skill'} 信息`,
  }
  return skillNames[name] || name || '工具调用'
}

function parseMaybeJson(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function formatContent(value, maxLength) {
  if (value === null || value === undefined) return ''
  let text = ''
  if (typeof value === 'string') {
    const parsed = parseMaybeJson(value)
    text = parsed && typeof parsed !== 'string' ? JSON.stringify(parsed, null, 2) : value
  } else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...` : text
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
  padding: 0 12px 12px 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
}

.wpe-list::-webkit-scrollbar { width: 3px; }
.wpe-list::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 2px;
}

.wpe-inspector {
  flex-shrink: 0;
  max-height: 38%;
  min-height: 120px;
  border-top: 1px solid var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.42);
  display: flex;
  flex-direction: column;
}

.wpe-inspector-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px 8px;
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
}

.wpe-inspector-close:hover {
  background: var(--color-hover-overlay);
  color: var(--color-text-primary);
}

.wpe-inspector-body {
  min-height: 0;
  overflow: auto;
  padding: 0 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wpe-detail-block {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.wpe-detail-label {
  font-size: 10px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--color-text-muted);
}

.wpe-detail-text {
  font-size: 12px;
  line-height: 1.55;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.wpe-detail-text.muted,
.muted {
  color: var(--color-text-muted);
}

.wpe-code {
  margin: 0;
  max-height: 190px;
  overflow: auto;
  padding: 8px 9px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.28);
  color: var(--color-text-secondary);
  font: 11px/1.5 var(--font-mono);
  white-space: pre-wrap;
  word-break: break-word;
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
  gap: 5px;
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
}
</style>
