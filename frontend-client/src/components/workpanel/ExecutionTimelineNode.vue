<template>
  <div class="etn" :class="[`etn--${node.type}`, `status-${normalizedStatus}`, { 'etn--nested': depth > 0 }]">
    <div class="etn-row">
      <div class="etn-rail" aria-hidden="true">
        <span class="etn-status-dot">
          <span v-if="isRunning" class="etn-status-pulse"></span>
        </span>
      </div>

      <section class="etn-card" :class="{ 'is-interactive': canToggle }">
        <button
          type="button"
          class="etn-summary"
          :disabled="!canToggle"
          :aria-expanded="canToggle ? expanded : undefined"
          @click="toggleExpanded"
        >
          <div class="etn-main">
            <div class="etn-kicker">
              <span class="etn-type">{{ typeLabel }}</span>
              <span v-if="agentLabel" class="agent-badge" :class="agentBadgeClass">{{ agentLabel }}</span>
            </div>

            <div class="etn-title">{{ titleText }}</div>
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

          <div class="etn-side">
            <span v-if="elapsedText" class="etn-time">{{ elapsedText }}</span>
            <span v-if="statusText" class="etn-status-pill">{{ statusText }}</span>
            <span v-if="canToggle" class="etn-chevron" :class="{ expanded }" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <path d="M7 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
          </div>
        </button>

        <div v-if="expanded && hasDetails" class="etn-details">
          <template v-if="node.type === 'agent_call'">
            <div v-if="node.description" class="etn-detail-block">
              <div class="etn-detail-label">任务</div>
              <div class="etn-detail-text">{{ node.description }}</div>
            </div>
            <div v-if="node.result_summary" class="etn-detail-block">
              <div class="etn-detail-label">结果</div>
              <div class="etn-detail-text">{{ node.result_summary }}</div>
            </div>
            <div v-if="node.ctx && node.ctx.max > 0" class="etn-context">
              <div class="etn-context-copy">
                <span>上下文</span>
                <span>{{ ctxPercent }}%</span>
              </div>
              <div class="etn-context-track">
                <span class="etn-context-fill" :style="{ width: ctxPercent + '%' }"></span>
              </div>
            </div>
          </template>

          <template v-else-if="node.type === 'tool_call'">
            <template v-if="node.tool_name === 'request_user_input'">
              <div v-if="node.arguments?.prompt" class="etn-detail-block">
                <div class="etn-detail-label">智能体提问</div>
                <div class="etn-detail-text">{{ node.arguments.prompt }}</div>
                <div v-if="Array.isArray(node.arguments?.options) && node.arguments.options.length > 0" class="etn-options">
                  <span v-for="option in node.arguments.options" :key="String(option)" class="etn-option">{{ option }}</span>
                </div>
              </div>
              <div v-if="previewResult && previewResult !== '（已取消）'" class="etn-detail-block">
                <div class="etn-detail-label">用户回答</div>
                <div class="etn-detail-text">{{ previewResult }}</div>
              </div>
              <div v-else-if="isRunning" class="etn-detail-block">
                <div class="etn-detail-text muted">等待用户输入中</div>
              </div>
            </template>

            <template v-else>
              <div v-if="hasArguments" class="etn-detail-block">
                <div class="etn-detail-label">输入参数</div>
                <pre class="etn-code">{{ formattedArguments }}</pre>
              </div>
              <div v-if="previewResult" class="etn-detail-block">
                <div class="etn-detail-label">执行结果</div>
                <pre class="etn-code result">{{ formattedResult }}</pre>
              </div>
            </template>
          </template>
        </div>
      </section>
    </div>

    <div v-if="expanded && node.children?.length" class="etn-children">
      <ExecutionTimelineNode
        v-for="(child, index) in node.children"
        :key="child.call_id || child.task_id || `${child.type}-${depth + 1}-${index}`"
        :node="child"
        :depth="depth + 1"
        :session-id="sessionId"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { getAgentBadgeClass } from '../../utils/agentBadge'

defineOptions({ name: 'ExecutionTimelineNode' })

const props = defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
  sessionId: { type: String, default: '' },
})

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
const hasArguments = computed(() => {
  const args = props.node.arguments
  if (!args) return false
  if (typeof args === 'object') return Object.keys(args).length > 0
  return String(args).trim().length > 0
})
const hasResult = computed(() => previewResult.value !== null && previewResult.value !== undefined && String(previewResult.value).trim().length > 0)
const hasDetails = computed(() => {
  if (props.node.type === 'agent_call') return Boolean(props.node.description || props.node.result_summary || props.node.ctx?.max)
  if (props.node.type === 'tool_call') return hasArguments.value || hasResult.value || props.node.tool_name === 'request_user_input'
  return false
})
const canToggle = computed(() => hasChildren.value || hasDetails.value)

const formattedArguments = computed(() => formatContent(props.node.arguments, 900))
const formattedResult = computed(() => formatContent(previewResult.value, 900))

const toolStatuses = computed(() => {
  if (props.node.type !== 'agent_call') return []
  const statuses = []
  collectToolStatuses(props.node.children || [], statuses)
  return statuses
})

const ctxPercent = computed(() => {
  const ctx = props.node.ctx
  if (!ctx?.max) return 0
  return Math.min(100, Math.round((ctx.used / ctx.max) * 100))
})

function toggleExpanded() {
  if (!canToggle.value) return
  expanded.value = !expanded.value
}

function defaultExpanded(node) {
  if (node.expanded !== undefined) return Boolean(node.expanded)
  if (node.tool_name === 'request_user_input') return true
  if (node.type === 'thought') return true
  if (node.status === 'running') return true
  return node.type === 'agent_call'
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

function hasRunningChild(node) {
  if (!Array.isArray(node.children)) return false
  return node.children.some(child => normalizeStatus(child.status) === 'running' || hasRunningChild(child))
}

function collectToolStatuses(children, statuses) {
  children.forEach(child => {
    if (child.type === 'tool_call') statuses.push(child.status || 'pending')
    if (Array.isArray(child.children)) collectToolStatuses(child.children, statuses)
  })
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
.etn {
  --status-color: var(--color-border);
  --status-border: var(--color-border);
  --status-bg: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.26);
  position: relative;
  letter-spacing: 0;
}

.etn + .etn {
  margin-top: 6px;
}

.etn-row {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 0;
  align-items: start;
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
  justify-content: center;
  padding-top: 17px;
}

.etn-rail::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: -8px;
  width: 1px;
  background: linear-gradient(180deg, transparent, var(--color-border) 14px, var(--color-border) calc(100% - 8px), transparent);
}

.etn-status-dot {
  position: relative;
  z-index: 1;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--status-color);
  box-shadow: 0 0 0 4px rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.86);
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
  transition: background var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.etn-card.is-interactive:hover {
  border-color: var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.36);
}

.etn--nested .etn-card {
  background: transparent;
}

.etn--nested .etn-card.is-interactive:hover {
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.2);
}

.etn--tool_call .etn-card {
  border-color: transparent;
  background: transparent;
}

.etn--tool_call .etn-card.is-interactive:hover {
  border-color: var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.24);
}

.etn-summary {
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
}

.etn-summary:disabled {
  cursor: default;
}

.etn-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.etn-kicker {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.etn-type {
  font-size: 10px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--color-text-muted);
  white-space: nowrap;
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
  overflow: hidden;
  text-overflow: ellipsis;
}

.etn-title {
  min-width: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--color-text-primary);
  font-weight: 600;
  overflow-wrap: anywhere;
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
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 1px;
  flex-shrink: 0;
}

.etn-time {
  font-size: 11px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.etn-status-pill {
  height: 20px;
  display: inline-flex;
  align-items: center;
  padding: 0 7px;
  border-radius: var(--radius-full);
  color: var(--status-color);
  border: 1px solid var(--status-border);
  background: var(--status-bg);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}

.etn-chevron {
  display: inline-flex;
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
}

.substep-running { background: var(--color-brand-accent); }
.substep-success { background: var(--color-success); }
.substep-error { background: var(--color-error); }
.substep-stopped { background: var(--color-warning); }

.etn-substep-more {
  font-size: 10px;
  color: var(--color-text-muted);
  line-height: 1;
}

.etn-details {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 10px 10px;
  padding: 9px 0 0;
  border-top: 1px solid var(--color-border);
  background: transparent;
}

.etn-detail-block {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.etn-detail-label {
  font-size: 10px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--color-text-muted);
}

.etn-detail-text {
  font-size: 12px;
  line-height: 1.55;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.etn-detail-text.muted {
  color: var(--color-text-muted);
}

.etn-code {
  margin: 0;
  max-height: 160px;
  overflow: auto;
  padding: 7px 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.28);
  color: var(--color-text-secondary);
  font: 11px/1.5 var(--font-mono);
  white-space: pre-wrap;
  word-break: break-word;
}

.etn-code.result {
  color: var(--color-result-text);
  background: var(--color-result-bg);
  border-color: var(--color-result-border);
}

.etn-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.etn-option {
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

.etn-context {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.etn-context-copy {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  color: var(--color-text-muted);
}

.etn-context-track {
  height: 4px;
  border-radius: var(--radius-full);
  overflow: hidden;
  background: var(--color-border);
}

.etn-context-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-brand-accent);
}

.etn-children {
  margin: 6px 0 0 22px;
  padding: 0;
}

.etn-children > .etn > .etn-row {
  grid-template-columns: 18px minmax(0, 1fr);
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
</style>
