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
          :class="{ 'etn-summary--compact': !hasChildren }"
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
            >
              <WorkPanelTimelineIcon :kind="nodeIconKind" />
            </span>

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

          <div class="etn-side" :class="{ 'etn-side--compact': !hasChildren }">
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

    <Transition
      name="etn-expand"
      @before-enter="prepareExpandEnter"
      @enter="runExpandEnter"
      @after-enter="finishExpandTransition"
      @enter-cancelled="finishExpandTransition"
      @before-leave="prepareExpandLeave"
      @leave="runExpandLeave"
      @after-leave="finishExpandTransition"
      @leave-cancelled="finishExpandTransition"
    >
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
import WorkPanelTimelineIcon from './WorkPanelTimelineIcon.vue'
import {
  getToolDisplayName as resolveToolDisplayName,
  getToolIconKind as resolveToolIconKind,
  getToolSubtitle,
} from '../../utils/toolPresentation'

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
const EXPAND_TRANSITION_MS = 230
const EXPAND_TRANSITION_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
const DEFAULT_EXPAND_GAP_PX = 5

const normalizedStatus = computed(() => {
  const ownStatus = normalizeStatus(props.node.status)
  if (ownStatus === 'pending' && hasRunningChild(props.node)) return 'running'
  return ownStatus
})
const isRunning = computed(() => normalizedStatus.value === 'running')
const agentLabel = computed(() => shortName(props.node.agent_display_name || props.node.agent_name || props.node.agent || ''))
const agentBadgeClass = computed(() => getAgentBadgeClass(props.node.agent_name || props.node.agent || props.node.agent_display_name))
const elapsedText = computed(() => formatElapsed(props.node.elapsed_time))
const nodeKeyValue = computed(() => getNodeKey(props.node))

const nodeIconKind = computed(() => {
  if (props.node.type === 'agent_call') return 'agent'
  if (props.node.type === 'thought') return 'thought'
  if (props.node.type === 'tool_call') return resolveToolIconKind(props.node.tool_name)
  return 'step'
})

const typeLabel = computed(() => {
  if (props.node.type === 'thought') return props.node.round ? `轮次 ${props.node.round}` : '思考'
  if (props.node.type === 'agent_call') return 'Agent'
  if (props.node.type === 'tool_call') return '工具'
  return props.node.type || '步骤'
})

const toolDisplayName = computed(() => {
  return resolveToolDisplayName(props.node)
})

const smartPreview = computed(() => {
  return getToolSubtitle(props.node, { running: isRunning.value })
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

function prepareExpandEnter(el) {
  if (shouldReduceMotion()) return
  Object.assign(el.style, {
    height: '0px',
    paddingTop: '0px',
    opacity: '0',
    overflow: 'hidden',
    willChange: 'height, padding-top, opacity',
  })
}

function runExpandEnter(el, done) {
  if (shouldReduceMotion()) {
    done()
    return
  }
  el.style.transition = expandTransition()
  requestAnimationFrame(() => {
    const gap = getExpandGapPx(el)
    el.style.height = `${el.scrollHeight + gap}px`
    el.style.paddingTop = `${gap}px`
    el.style.opacity = '1'
  })
  finishAfterHeightTransition(el, done)
}

function prepareExpandLeave(el) {
  if (shouldReduceMotion()) return
  const styles = getComputedStyle(el)
  Object.assign(el.style, {
    height: `${el.scrollHeight}px`,
    paddingTop: styles.paddingTop,
    opacity: '1',
    overflow: 'hidden',
    willChange: 'height, padding-top, opacity',
  })
}

function runExpandLeave(el, done) {
  if (shouldReduceMotion()) {
    done()
    return
  }
  el.style.transition = expandTransition()
  void el.offsetHeight
  requestAnimationFrame(() => {
    el.style.height = '0px'
    el.style.paddingTop = '0px'
    el.style.opacity = '0'
  })
  finishAfterHeightTransition(el, done)
}

function finishExpandTransition(el) {
  const animatedStyles = ['height', 'paddingTop', 'opacity', 'overflow', 'transition', 'willChange']
  animatedStyles.forEach((name) => {
    el.style[name] = ''
  })
}

function finishAfterHeightTransition(el, done) {
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    el.removeEventListener('transitionend', onTransitionEnd)
    done()
  }
  const onTransitionEnd = (event) => {
    if (event.target === el && event.propertyName === 'height') finish()
  }
  el.addEventListener('transitionend', onTransitionEnd)
  window.setTimeout(finish, EXPAND_TRANSITION_MS + 80)
}

function expandTransition() {
  return [
    `height ${EXPAND_TRANSITION_MS}ms ${EXPAND_TRANSITION_EASE}`,
    `padding-top ${EXPAND_TRANSITION_MS}ms ${EXPAND_TRANSITION_EASE}`,
    `opacity 160ms ease`,
  ].join(', ')
}

function getExpandGapPx(el) {
  const value = parseFloat(getComputedStyle(el).getPropertyValue('--child-gap'))
  return Number.isFinite(value) ? value : DEFAULT_EXPAND_GAP_PX
}

function shouldReduceMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
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

</script>

<style scoped>
.etn {
  --status-color: var(--color-border);
  --status-border: var(--color-border);
  --status-bg: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.26);
  --selection-border: rgba(var(--color-brand-accent-rgb), 0.34);
  --selection-bg: rgba(var(--color-brand-accent-rgb), 0.085);
  --selection-ring: rgba(var(--color-brand-accent-rgb), 0.08);
  --rail-width: 22px;
  --child-rail-width: 16px;
  --child-indent: 20px;
  --rail-dot-top: 17px;
  --rail-dot-size: 9px;
  --rail-dot-center: calc(var(--rail-dot-top) + (var(--rail-dot-size) / 2));
  --branch-opacity: 0.48;
  position: relative;
  letter-spacing: 0;
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
  --rail-width: 16px;
  --child-rail-width: 14px;
  --child-indent: 18px;
  --rail-dot-top: 16px;
  --rail-dot-size: 7px;
  --branch-opacity: 0.4;
}

.etn.status-running {
  --status-color: var(--color-brand-accent);
  --status-border: rgba(var(--color-brand-accent-rgb), 0.28);
  --status-bg: rgba(var(--color-brand-accent-rgb), 0.1);
}

.etn.status-success {
  --status-color: var(--color-success);
  --status-border: rgba(var(--color-success-rgb), 0.2);
  --status-bg: rgba(var(--color-success-rgb), 0.055);
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
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06);
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

.etn--nested .etn-card {
  border-color: transparent;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.1);
}

.etn--nested .etn-card.is-interactive:not(.is-selected):hover {
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.18);
}

.etn--tool_call .etn-card {
  border-color: transparent;
  background: transparent;
}

.etn--nested.etn--tool_call .etn-card {
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.06);
}

.etn--tool_call .etn-card.is-interactive:not(.is-selected):hover {
  border-color: var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.24);
}

.etn--nested.etn--tool_call .etn-card.is-interactive:not(.is-selected):hover {
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.14);
}

.etn-card.is-selected,
.etn--nested .etn-card.is-selected,
.etn--tool_call .etn-card.is-selected,
.etn--nested.etn--tool_call .etn-card.is-selected {
  border-color: var(--selection-border);
  background: var(--selection-bg);
  box-shadow: inset 0 0 0 1px var(--selection-ring);
}

.etn-summary {
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(104px, max-content);
  align-items: start;
  gap: 10px;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
}

.etn-summary--compact {
  grid-template-columns: minmax(0, 1fr) max-content;
}

.etn--agent_call .etn-summary {
  grid-template-columns: minmax(0, 1fr) max-content;
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
  gap: 4px;
}

.etn-title-row {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
}

.etn-type-icon {
  --type-color: var(--color-text-muted);
  --type-rgb: 142, 142, 147;
  width: 22px;
  height: 20px;
  border-radius: 7px;
  border: 1px solid rgba(var(--type-rgb), 0.24);
  background: rgba(var(--type-rgb), 0.08);
  color: var(--type-color);
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

.etn-type-icon.icon-agent {
  --type-color: #a855f7;
  --type-rgb: 168, 85, 247;
}

.etn-type-icon.icon-thought {
  --type-color: var(--color-warning);
  --type-rgb: var(--color-warning-rgb);
}

.etn-type-icon.icon-tool {
  --type-color: #94a3b8;
  --type-rgb: 148, 163, 184;
}

.etn-type-icon.icon-code {
  --type-color: var(--color-brand-accent);
  --type-rgb: var(--color-brand-accent-rgb);
}

.etn-type-icon.icon-file {
  --type-color: var(--color-success);
  --type-rgb: var(--color-success-rgb);
}

.etn-type-icon.icon-search {
  --type-color: #22d3ee;
  --type-rgb: 34, 211, 238;
}

.etn-type-icon.icon-globe {
  --type-color: #38bdf8;
  --type-rgb: 56, 189, 248;
}

.etn-type-icon.icon-map {
  --type-color: #34d399;
  --type-rgb: 52, 211, 153;
}

.etn-type-icon.icon-chart {
  --type-color: #f472b6;
  --type-rgb: 244, 114, 182;
}

.etn-type-icon.icon-skill {
  --type-color: #a78bfa;
  --type-rgb: 167, 139, 250;
}

.etn-type-icon.icon-input {
  --type-color: var(--color-warning);
  --type-rgb: var(--color-warning-rgb);
}

.etn-type-icon.icon-database {
  --type-color: #14b8a6;
  --type-rgb: 20, 184, 166;
}

.etn-type-icon.icon-task {
  --type-color: #fb923c;
  --type-rgb: 251, 146, 60;
}

.etn-type-icon.icon-agentCall {
  --type-color: #8b5cf6;
  --type-rgb: 139, 92, 246;
}

.etn-type-icon.icon-step {
  --type-color: var(--color-text-muted);
  --type-rgb: 142, 142, 147;
}

.etn-card.is-selected .etn-type-icon {
  color: var(--type-color);
  border-color: rgba(var(--type-rgb), 0.34);
  background: rgba(var(--type-rgb), 0.12);
}

.agent-badge {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: min(112px, 38%);
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
  line-height: 1.35;
  color: var(--color-text-primary);
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.etn-subtitle {
  min-width: 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-secondary);
  opacity: 0.78;
  overflow: hidden;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.etn-side {
  min-width: 104px;
  display: grid;
  grid-template-columns: minmax(38px, max-content) minmax(46px, max-content) 16px;
  align-items: center;
  gap: 5px;
  padding-top: 1px;
  flex-shrink: 0;
  justify-items: end;
}

.etn-side--compact {
  min-width: 0;
  grid-template-columns: minmax(38px, max-content) minmax(46px, max-content);
}

.etn--agent_call .etn-side {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  width: max-content;
}

.etn-time {
  width: 38px;
  font-size: 11px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-align: right;
}

.etn-status-pill {
  min-width: 46px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
  border-radius: var(--radius-full);
  color: var(--status-color);
  border: 1px solid var(--status-border);
  background: var(--status-bg);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
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

.etn--agent_call .etn-time {
  width: 34px;
  font-size: 10px;
}

.etn--agent_call .etn-status-pill {
  min-width: 40px;
  height: 18px;
  padding: 0 6px;
  font-size: 9px;
}

.etn--agent_call .etn-chevron {
  width: 12px;
}

.etn--agent_call .etn-chevron :deep(svg) {
  width: 12px;
  height: 12px;
}

.etn-chevron.expanded {
  transform: rotate(90deg);
  color: var(--color-text-secondary);
}

.etn-substeps {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  padding-top: 1px;
  opacity: 0.82;
}

.etn-substep-dot {
  width: 4px;
  height: 4px;
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
  padding-left: 1px;
}

.etn-children {
  --child-gap: 5px;
  --timeline-rail-thickness: 1px;
  position: relative;
  box-sizing: border-box;
  margin: 0 0 0 var(--child-indent);
  padding: var(--child-gap) 0 0;
  transform-origin: top;
}

.etn-children::before {
  content: '';
  position: absolute;
  left: calc((var(--rail-width) / 2) - var(--child-indent));
  top: 0;
  width: calc(var(--child-indent) + (var(--child-rail-width) / 2) - (var(--rail-width) / 2));
  height: var(--timeline-rail-thickness);
  border-radius: var(--radius-full);
  background: var(--color-border);
  opacity: var(--branch-opacity);
  pointer-events: none;
}

.etn-children::after {
  content: '';
  position: absolute;
  left: calc((var(--child-rail-width) - var(--timeline-rail-thickness)) / 2);
  top: 0;
  bottom: 2px;
  width: var(--timeline-rail-thickness);
  border-radius: var(--radius-full);
  background: var(--color-border);
  opacity: var(--branch-opacity);
  pointer-events: none;
  mask-image: linear-gradient(to bottom, transparent 0, #000 6px, #000 calc(100% - 12px), transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 6px, #000 calc(100% - 12px), transparent 100%);
}

.etn-children:not(:has(> .etn + .etn)):not(:has(> .etn--has-children))::after {
  bottom: auto;
  height: calc(var(--rail-dot-center) + 4px);
}

.etn-children > .etn > .etn-row {
  grid-template-columns: var(--rail-width) minmax(0, 1fr);
}

.etn-children > .etn {
  position: relative;
  z-index: 1;
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
  overflow: hidden;
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
  .etn-status-leave-active {
    transition-duration: 1ms;
  }

  .etn-status-enter-from,
  .etn-status-leave-to {
    transform: none;
  }
}
</style>
