<template>
  <div
    class="etn"
    :class="[
      `etn--${node.type}`,
      `status-${normalizedStatus}`,
      { 'etn--nested': depth > 0, 'etn--has-children': hasChildren },
    ]"
    :data-node-key="nodeKeyValue"
  >
    <div class="etn-row">
      <div class="etn-rail" aria-hidden="true">
        <span class="etn-status-dot">
          <span v-if="isRunning" class="etn-status-pulse"></span>
        </span>
      </div>

      <section class="etn-card" :class="{ 'is-interactive': true, 'is-selected': selectedKey === nodeKeyValue }">
        <button
          type="button"
          class="etn-summary"
          :aria-expanded="hasChildren ? expanded : undefined"
          @click="handleSummaryClick"
        >
          <div class="etn-main">
            <span
              class="etn-type-icon"
              :class="`icon-${nodeIconKind}`"
              :title="typeLabel"
              :aria-label="typeLabel"
              role="img"
              v-html="nodeIconSvg"
            ></span>

            <div class="etn-content">
              <div class="etn-title-row">
                <div class="etn-title">{{ titleText }}</div>
                <span v-if="agentLabel" class="agent-badge" :class="agentBadgeClass">{{ agentLabel }}</span>
              </div>

              <div v-if="subtitleText" class="etn-subtitle">{{ subtitleText }}</div>

              <div v-if="node.type === 'agent_call' && toolStatuses.length > 0" class="etn-substeps">
                <span
                  v-for="(status, index) in toolStatuses.slice(0, 8)"
                  :key="`${status}-${index}`"
                  class="etn-substep-dot"
                  :class="`substep-${normalizeStatus(status)}`"
                ></span>
                <span v-if="toolStatuses.length > 8" class="etn-substep-more">+{{ toolStatuses.length - 8 }}</span>
              </div>
            </div>
          </div>

          <div class="etn-side">
            <span v-if="elapsedText" class="etn-time">{{ elapsedText }}</span>
            <Transition name="etn-status" mode="out-in">
              <span v-if="statusText" :key="statusText" class="etn-status-pill">{{ statusText }}</span>
            </Transition>
            <span v-if="hasChildren" class="etn-chevron" :class="{ expanded }" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <path d="M7 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
          </div>
        </button>
      </section>
    </div>

    <Transition name="etn-expand">
      <div v-if="expanded && node.children?.length" class="etn-children">
        <ExecutionTimelineNode
          v-for="(child, index) in node.children"
          :key="child.call_id || child.task_id || `${child.type}-${depth + 1}-${index}`"
          :node="child"
          :depth="depth + 1"
          :session-id="sessionId"
          :focus-key="focusKey"
          :selected-key="selectedKey"
          @inspect="emit('inspect', $event)"
        />
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { getAgentBadgeClass } from '../../utils/agentBadge'

defineOptions({ name: 'ExecutionTimelineNode' })

const props = defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
  sessionId: { type: String, default: '' },
  focusKey: { type: String, default: '' },
  selectedKey: { type: String, default: '' },
})
const emit = defineEmits(['inspect'])

const expanded = ref(defaultExpanded(props.node))

const TOOL_DISPLAY_NAMES = {
  request_user_input: '请求用户输入',
}

const SKILL_TOOL_TEMPLATES = {
  activate_skill: (args) => `激活 ${args?.skill_name || 'Skill'}`,
  load_skill_resource: (args) => `加载 ${args?.skill_name || 'Skill'} 资源`,
  execute_skill_script: (args) => `执行 ${args?.skill_name || 'Skill'} 脚本`,
  get_skill_info: (args) => `查询 ${args?.skill_name || 'Skill'} 信息`,
}

const NODE_ICON_SVG = {
  agent: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>',
  thought: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M8.5 14.5a6 6 0 1 1 7 0c-.9.6-1.5 1.6-1.5 2.5h-4c0-.9-.6-1.9-1.5-2.5Z"/></svg>',
  tool: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.9 2.9-3-3 2.9-2.9Z"/></svg>',
  code: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 5h16v14H4z"/><path d="m8 9 3 3-3 3"/><path d="M13 15h3"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/></svg>',
  map: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 18-6 3V6l6-3 6 3 6-3v15l-6 3-6-3Z"/><path d="M9 3v15"/><path d="M15 6v15"/></svg>',
  chart: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 19V5"/><path d="M4 19h16"/><rect x="7" y="11" width="3" height="5" rx="1"/><rect x="12" y="8" width="3" height="8" rx="1"/><rect x="17" y="5" width="3" height="11" rx="1"/></svg>',
  skill: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z"/><path d="M5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14Z"/><path d="M19 14l.6 1.6L21 16l-1.4.4L19 18l-.6-1.6L17 16l1.4-.4L19 14Z"/></svg>',
  input: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 5h16v12H7l-3 3V5Z"/><path d="M8 10h8"/><path d="M8 14h5"/></svg>',
  database: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>',
  task: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 6h14"/><path d="M5 12h14"/><path d="M5 18h8"/><path d="m15 18 2 2 4-4"/></svg>',
  agentCall: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="7" cy="12" r="3"/><circle cx="17" cy="6" r="3"/><circle cx="17" cy="18" r="3"/><path d="M10 11l4-3"/><path d="M10 13l4 3"/></svg>',
  step: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="7"/><path d="M12 8v4l3 2"/></svg>',
}

const normalizedStatus = computed(() => {
  const ownStatus = normalizeStatus(props.node.status)
  if (ownStatus === 'pending' && hasRunningChild(props.node)) return 'running'
  return ownStatus
})
const isRunning = computed(() => normalizedStatus.value === 'running')
const agentLabel = computed(() => shortName(props.node.agent_display_name || props.node.agent_name || props.node.agent || ''))
const agentBadgeClass = computed(() => getAgentBadgeClass(props.node.agent_name || props.node.agent || props.node.agent_display_name))
const elapsedText = computed(() => formatElapsed(props.node.elapsed_time))
const previewResult = computed(() => props.node?.result_preview ?? props.node?.result ?? '')
const nodeKeyValue = computed(() => getNodeKey(props.node))

const nodeIconKind = computed(() => {
  if (props.node.type === 'agent_call') return 'agent'
  if (props.node.type === 'thought') return 'thought'
  if (props.node.type === 'tool_call') return getToolIconKind(props.node.tool_name)
  return 'step'
})
const nodeIconSvg = computed(() => NODE_ICON_SVG[nodeIconKind.value] || NODE_ICON_SVG.step)

const typeLabel = computed(() => {
  if (props.node.type === 'thought') return props.node.round ? `轮次 ${props.node.round}` : '思考'
  if (props.node.type === 'agent_call') return 'Agent'
  if (props.node.type === 'tool_call') return '工具'
  return props.node.type || '步骤'
})

const toolDisplayName = computed(() => {
  const name = props.node.tool_name || ''
  if (TOOL_DISPLAY_NAMES[name]) return TOOL_DISPLAY_NAMES[name]
  const tpl = SKILL_TOOL_TEMPLATES[name]
  if (tpl) return tpl(props.node.arguments)
  return name || '工具调用'
})

const smartPreview = computed(() => {
  if (props.node.type !== 'tool_call' || normalizedStatus.value === 'running') return ''
  const name = props.node.tool_name || ''
  if (name === 'call_agent') {
    const calledAgent = props.node.linkedAgentCall?.agent_display_name || props.node.arguments?.agent_name || ''
    return calledAgent ? `调用 ${shortName(calledAgent)}` : ''
  }

  const parsed = parseMaybeJson(previewResult.value)
  if (['create_chart', 'create_map', 'create_bindmap', 'create_risk_map', 'revise_visualization'].includes(name)) {
    const title = parsed?.title || parsed?.preview?.title || ''
    return title ? `已生成：${title}` : '已生成可视化'
  }
  if (name === 'query_emergency_plan') {
    const count = parsed?.results?.length ?? parsed?.total
    if (count != null) return `${count} 条结果`
  }
  if (name === 'assess_flood_risk') {
    const level = parsed?.risk_level ?? parsed?.risk_label
    if (level) return `${level}级风险`
  }
  if (name === 'generate_report' && parsed?.title) return parsed.title
  if (name === 'execute_code' || name === 'execute_bash') {
    const code = parsed?.exit_code ?? parsed?.metadata?.exit_code
    if (code != null) return code === 0 ? '执行成功' : `退出码 ${code}`
  }
  if (name === 'match_emergency_response') {
    const count = parsed?.matched_plans?.length
    if (count != null) return `${count} 个匹配方案`
  }
  const summary = parsed?.summary || parsed?.message
  return typeof summary === 'string' ? truncate(summary, 42) : ''
})

const titleText = computed(() => {
  if (props.node.type === 'thought') {
    return truncate(props.node.intent || props.node.thought || props.node.thinking || (isRunning.value ? '思考中' : '思考记录'), 84)
  }
  if (props.node.type === 'agent_call') {
    return truncate(props.node.description || props.node.result_summary || agentLabel.value || '调用智能体', 84)
  }
  if (props.node.type === 'tool_call') {
    return toolDisplayName.value
  }
  return '执行步骤'
})

const subtitleText = computed(() => {
  if (props.node.type === 'agent_call') {
    if (props.node.result_summary && props.node.description) return truncate(props.node.result_summary, 72)
    return ''
  }
  if (props.node.type === 'tool_call') {
    return smartPreview.value
  }
  return ''
})

const statusText = computed(() => {
  const text = {
    running: '执行中',
    success: '完成',
    error: '失败',
    stopped: '已停止',
    pending: '',
  }
  return text[normalizedStatus.value] ?? ''
})

const hasChildren = computed(() => Array.isArray(props.node.children) && props.node.children.length > 0)
watch(
  () => [props.focusKey, props.node.status, props.node.children?.length],
  () => {
    if (hasChildren.value && shouldRevealNode(props.node, props.focusKey)) {
      expanded.value = true
    }
  },
  { immediate: true }
)

const toolStatuses = computed(() => {
  if (props.node.type !== 'agent_call') return []
  const statuses = []
  collectToolStatuses(props.node.children || [], statuses)
  return statuses
})

function handleSummaryClick() {
  emit('inspect', props.node)
  if (!hasChildren.value) return
  expanded.value = !expanded.value
}

function defaultExpanded(node) {
  if (node.expanded !== undefined) return Boolean(node.expanded)
  return shouldRevealNode(node, props.focusKey)
}

function shortName(name) {
  if (!name) return ''
  return String(name).replace(/_agent$/i, '').replace(/_/g, ' ')
}

function truncate(value, max) {
  const text = String(value || '').trim()
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function normalizeStatus(status) {
  if (status === 'completed' || status === 'success') return 'success'
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'cancelled' || status === 'stopped') return 'stopped'
  if (status === 'running') return 'running'
  return 'pending'
}

function getNodeKey(node) {
  if (!node) return ''
  if (node.call_id) return `call:${node.call_id}`
  if (node.task_id) return `task:${node.task_id}`
  const identity = node.tool_name || node.agent_name || node.agent || node.agent_display_name || node.intent || node.description || ''
  return `${node.type || 'node'}:${node.round || ''}:${String(identity).slice(0, 80)}`
}

function shouldRevealNode(node, focusKey) {
  if (!node) return false
  const status = normalizeStatus(node.status)
  if (status === 'running' || status === 'error') return true
  if (node.tool_name === 'request_user_input') return true
  if (hasRunningChild(node) || hasErrorChild(node)) return true
  return Boolean(focusKey && containsNodeKey(node, focusKey))
}

function hasRunningChild(node) {
  if (!Array.isArray(node.children)) return false
  return node.children.some(child => normalizeStatus(child.status) === 'running' || hasRunningChild(child))
}

function hasErrorChild(node) {
  if (!Array.isArray(node.children)) return false
  return node.children.some(child => normalizeStatus(child.status) === 'error' || hasErrorChild(child))
}

function containsNodeKey(node, key) {
  if (!key || !node) return false
  if (getNodeKey(node) === key) return true
  if (!Array.isArray(node.children)) return false
  return node.children.some(child => containsNodeKey(child, key))
}

function collectToolStatuses(children, statuses) {
  children.forEach(child => {
    if (child.type === 'tool_call') statuses.push(child.status || 'pending')
    if (Array.isArray(child.children)) collectToolStatuses(child.children, statuses)
  })
}

function getToolIconKind(toolName = '') {
  const name = String(toolName || '').toLowerCase()
  if (name === 'request_user_input') return 'input'
  if (name === 'call_agent') return 'agentCall'
  if (name.includes('skill')) return 'skill'
  if (name.includes('map') || name.includes('geo') || name.includes('spatial') || name.includes('basin')) return 'map'
  if (name.includes('chart') || name.includes('visual') || name.includes('risk_matrix')) return 'chart'
  if (name.includes('bash') || name.includes('code') || name.includes('script') || name.includes('terminal')) return 'code'
  if (name.includes('file') || name.includes('document') || name.includes('report') || name.includes('artifact')) return 'file'
  if (name.includes('grep') || name.includes('glob') || name.includes('search') || name.includes('query') || name.includes('explore')) return 'search'
  if (name.includes('web') || name.includes('fetch') || name.includes('http') || name.includes('url')) return 'globe'
  if (name.includes('memory') || name.includes('vector') || name.includes('database') || name.includes('store')) return 'database'
  if (name.includes('task') || name.includes('todo') || name.includes('plan') || name.includes('approval')) return 'task'
  return 'tool'
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

</script>

<style scoped>
.etn {
  --status-color: var(--color-border);
  --status-border: var(--color-border);
  --status-bg: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.26);
  --rail-width: 22px;
  --child-rail-width: 18px;
  --child-indent: 22px;
  --rail-dot-top: 17px;
  --rail-dot-size: 9px;
  --rail-dot-center: calc(var(--rail-dot-top) + (var(--rail-dot-size) / 2));
  position: relative;
  letter-spacing: 0;
  animation: etn-row-enter 220ms ease-out both;
}

.etn + .etn {
  margin-top: 6px;
}

.etn-row {
  display: grid;
  grid-template-columns: var(--rail-width) minmax(0, 1fr);
  gap: 0;
  align-items: stretch;
}

.etn--nested {
  --rail-width: 18px;
}

.etn.status-running {
  --status-color: var(--color-brand-accent);
  --status-border: rgba(var(--color-brand-accent-rgb), 0.28);
  --status-bg: rgba(var(--color-brand-accent-rgb), 0.1);
}

.etn.status-success {
  --status-color: var(--color-success);
  --status-border: rgba(var(--color-success-rgb), 0.24);
  --status-bg: rgba(var(--color-success-rgb), 0.09);
}

.etn.status-error {
  --status-color: var(--color-error);
  --status-border: rgba(var(--color-error-rgb), 0.26);
  --status-bg: rgba(var(--color-error-rgb), 0.1);
}

.etn.status-stopped {
  --status-color: var(--color-warning);
  --status-border: rgba(var(--color-warning-rgb), 0.26);
  --status-bg: rgba(var(--color-warning-rgb), 0.1);
}

.etn-rail {
  position: relative;
  display: flex;
  align-self: stretch;
  justify-content: center;
  min-height: calc(var(--rail-dot-top) + var(--rail-dot-size) + 8px);
  padding-top: var(--rail-dot-top);
}

.etn-status-dot {
  position: relative;
  z-index: 1;
  width: var(--rail-dot-size);
  height: var(--rail-dot-size);
  border-radius: 999px;
  background: var(--status-color);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08);
  transition:
    background var(--transition-fast),
    box-shadow var(--transition-fast);
}

.etn-status-pulse {
  position: absolute;
  inset: -5px;
  border-radius: 999px;
  border: 1px solid var(--status-color);
  opacity: 0.5;
  animation: etn-pulse 1.5s ease-out infinite;
}

@keyframes etn-pulse {
  0% { transform: scale(0.7); opacity: 0.7; }
  100% { transform: scale(1.35); opacity: 0; }
}

.etn-card {
  min-width: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.22);
  position: relative;
  overflow: hidden;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.etn-card.is-interactive:not(.is-selected):hover {
  border-color: var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.36);
}

.etn-card.is-selected {
  border-color: var(--status-border);
  background: var(--status-bg);
  box-shadow: inset 0 0 0 1px var(--status-border);
}

.etn:not(.status-success):not(.status-error):not(.status-running):not(.status-stopped) .etn-card.is-selected {
  border-color: rgba(var(--color-brand-accent-rgb), 0.34);
  background: rgba(var(--color-brand-accent-rgb), 0.1);
  box-shadow: inset 0 0 0 1px rgba(var(--color-brand-accent-rgb), 0.08);
}

.etn--nested .etn-card {
  background: transparent;
}

.etn--nested .etn-card.is-interactive:not(.is-selected):hover {
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.2);
}

.etn--nested .etn-card.is-selected {
  background: var(--status-bg);
}

.etn--nested:not(.status-success):not(.status-error):not(.status-running):not(.status-stopped) .etn-card.is-selected {
  background: rgba(var(--color-brand-accent-rgb), 0.1);
}

.etn--tool_call .etn-card {
  border-color: transparent;
  background: transparent;
}

.etn--tool_call .etn-card.is-interactive:not(.is-selected):hover {
  border-color: var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.24);
}

.etn--tool_call .etn-card.is-selected {
  border-color: var(--status-border);
  background: var(--status-bg);
}

.etn--tool_call:not(.status-success):not(.status-error):not(.status-running):not(.status-stopped) .etn-card.is-selected {
  border-color: rgba(var(--color-brand-accent-rgb), 0.34);
  background: rgba(var(--color-brand-accent-rgb), 0.1);
}

.etn-summary {
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content;
  align-items: start;
  gap: 8px;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
}

.etn-summary:disabled {
  cursor: default;
}

.etn-main {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 8px;
}

.etn-content {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.etn-title-row {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.etn-type-icon {
  width: 22px;
  height: 20px;
  border-radius: 7px;
  border: 1px solid var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.24);
  color: var(--color-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 1px;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast),
    background var(--transition-fast);
}

.etn-type-icon :deep(svg) {
  width: 13px;
  height: 13px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.etn-card.is-selected .etn-type-icon,
.etn.status-running .etn-type-icon,
.etn.status-success .etn-type-icon,
.etn.status-error .etn-type-icon,
.etn.status-stopped .etn-type-icon {
  color: var(--status-color);
  border-color: var(--status-border);
  background: var(--status-bg);
}

.etn:not(.status-success):not(.status-error):not(.status-running):not(.status-stopped) .etn-card.is-selected .etn-type-icon {
  color: var(--color-brand-accent);
  border-color: rgba(var(--color-brand-accent-rgb), 0.34);
  background: rgba(var(--color-brand-accent-rgb), 0.1);
}

.agent-badge {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 150px;
  height: 18px;
  padding: 0 7px;
  border-radius: var(--radius-full);
  font-size: 10px;
  line-height: 1;
  font-weight: 700;
  white-space: nowrap;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.etn-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--color-text-primary);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.etn-subtitle {
  min-width: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--color-text-muted);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.etn-side {
  display: grid;
  grid-template-columns: max-content max-content 16px;
  align-items: center;
  gap: 6px;
  padding-top: 1px;
  flex-shrink: 0;
  justify-items: end;
}

.etn-time {
  min-width: 38px;
  font-size: 11px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-align: right;
}

.etn-status-pill {
  min-width: 42px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 7px;
  border-radius: var(--radius-full);
  color: var(--status-color);
  border: 1px solid var(--status-border);
  background: var(--status-bg);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast),
    background var(--transition-fast);
}

.etn-chevron {
  display: inline-flex;
  width: 16px;
  justify-content: center;
  color: var(--color-text-muted);
  transition: transform var(--transition-fast), color var(--transition-fast);
}

.etn-chevron.expanded {
  transform: rotate(90deg);
  color: var(--color-text-secondary);
}

.etn-substeps {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding-top: 1px;
}

.etn-substep-dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--color-border);
  transition: background var(--transition-fast), opacity var(--transition-fast);
}

.substep-running {
  background: var(--color-brand-accent);
  animation: etn-substep-pulse 1.5s ease-in-out infinite;
}

.substep-success { background: var(--color-success); }
.substep-error { background: var(--color-error); }
.substep-stopped { background: var(--color-warning); }

.etn-substep-more {
  font-size: 10px;
  color: var(--color-text-muted);
  line-height: 1;
}

.etn-children {
  --timeline-rail-thickness: 2px;
  position: relative;
  margin: 6px 0 0 var(--child-indent);
  padding: 0;
  transform-origin: top;
}

/* .etn-children::before {
  content: '';
  position: absolute;
  left: calc((var(--rail-width) / 2) - var(--child-indent) - 1px);
  top: -6px;
  width: calc(var(--child-indent) + (var(--child-rail-width) / 2) - (var(--rail-width) / 2) + 2px);
  height: var(--timeline-rail-thickness);
  border-radius: var(--radius-full);
  background: var(--color-border);
  opacity: 0.7;
} */

.etn-children::after {
  content: '';
  position: absolute;
  left: calc((var(--child-rail-width) - var(--timeline-rail-thickness)) / 2);
  top: -6px;
  bottom: 0;
  width: var(--timeline-rail-thickness);
  border-radius: var(--radius-full);
  background: var(--color-border);
  opacity: 0.7;
  pointer-events: none;
  mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 14px), transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 14px), transparent 100%);
}

.etn-children:not(:has(> .etn + .etn)):not(:has(> .etn--has-children))::after {
  bottom: auto;
  height: calc(var(--rail-dot-center) + 6px);
}

.etn-children > .etn > .etn-row {
  grid-template-columns: var(--rail-width) minmax(0, 1fr);
}

.etn-children > .etn {
  position: relative;
  z-index: 1;
}

@media (max-width: 1320px) {
  .etn-summary {
    grid-template-columns: minmax(0, 1fr);
  }

  .etn-side {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
}

.etn-status-enter-active,
.etn-status-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.etn-status-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.etn-status-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.etn-expand-enter-active,
.etn-expand-leave-active {
  transition: opacity 180ms ease, transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.etn-expand-enter-from,
.etn-expand-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@keyframes etn-row-enter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes etn-substep-pulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.45;
    transform: scale(0.75);
  }
}

@media (prefers-reduced-motion: reduce) {
  .etn,
  .etn-status-pulse,
  .substep-running {
    animation: none;
  }

  .etn-status-dot,
  .etn-card,
  .etn-status-pill,
  .etn-substep-dot,
  .etn-chevron,
  .etn-status-enter-active,
  .etn-status-leave-active,
  .etn-expand-enter-active,
  .etn-expand-leave-active {
    transition-duration: 1ms;
  }

  .etn-status-enter-from,
  .etn-status-leave-to,
  .etn-expand-enter-from,
  .etn-expand-leave-to {
    transform: none;
  }
}
</style>
