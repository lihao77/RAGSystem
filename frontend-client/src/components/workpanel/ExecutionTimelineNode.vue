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
        <div class="etn-summary-shell">
          <button
            type="button"
            :class="cn('etn-summary', { 'etn-summary--leaf': !hasChildren })"
            :aria-label="`查看 ${titleText} 详情`"
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

                <div
                  v-if="node.type === 'agent_call' && toolStatuses.length > 0"
                  class="etn-agent-progress"
                  :class="`tone-${toolProgressTone}`"
                >
                  {{ toolProgressText }}
                </div>
              </div>
            </div>

            <div class="etn-side">
              <span
                v-if="elapsedText"
                class="etn-time"
                :aria-label="`步骤耗时 ${elapsedText}`"
                :title="`步骤耗时 ${elapsedText}`"
              >
                {{ elapsedText }}
              </span>
              <Transition name="etn-status" mode="out-in">
                <span
                  v-if="normalizedStatus === 'success'"
                  key="success"
                  class="etn-status-success"
                  aria-label="完成"
                  title="完成"
                >
                  <Check aria-hidden="true" />
                </span>
                <Badge
                  v-else-if="statusText"
                  :key="normalizedStatus"
                  :variant="statusBadgeVariant"
                  class="etn-status-badge"
                >
                  {{ statusText }}
                </Badge>
              </Transition>
            </div>
          </button>

          <Button
            v-if="hasChildren"
            class="etn-expand-toggle"
            variant="ghost"
            size="icon-xs"
            type="button"
            :active="expanded"
            :data-state="expanded ? 'open' : 'closed'"
            :aria-expanded="expanded"
            :aria-label="expanded ? '收起子步骤' : '展开子步骤'"
            :title="expanded ? '收起子步骤' : '展开子步骤'"
            @click="toggleExpanded"
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
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
          @layout-change="emit('layoutChange')"
        />
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { Check, ChevronRight } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { cn } from '@/lib/utils'
import { getAgentBadgeClass } from '../../utils/agentBadge'
import {
  formatExecutionElapsed as formatElapsed,
  getExecutionNodeKey as getNodeKey,
  normalizeExecutionStatus as normalizeStatus,
} from '../../utils/executionTreePresentation'
import WorkPanelTimelineIcon from './WorkPanelTimelineIcon.vue'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
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
const emit = defineEmits(['inspect', 'layoutChange'])

const expanded = ref(defaultExpanded(props.node))
const EXPAND_TRANSITION_MS = 230
const EXPAND_TRANSITION_EASE = 'var(--ease-out-expo)'
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
  if (props.node.type === 'injection') return 'input'
  if (props.node.type === 'tool_call') return resolveToolIconKind(props.node.tool_name)
  return 'step'
})

const typeLabel = computed(() => {
  if (props.node.type === 'thought') return '思考'
  if (props.node.type === 'agent_call') return 'Agent'
  if (props.node.type === 'injection') return props.node.injection_kind === 'background_notification' ? '后台通知' : '用户补充'
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
    const intent = props.node.intent || props.node.thought || props.node.thinking;
    if (intent) return truncate(intent, 84);
    return isRunning.value ? '思考中' : (props.node.round != null ? `轮次 ${props.node.round}` : '执行记录');
  }
  if (props.node.type === 'agent_call') {
    return truncate(props.node.description || props.node.result_summary || agentLabel.value || '调用智能体', 84)
  }
  if (props.node.type === 'tool_call') {
    return toolDisplayName.value
  }
  if (props.node.type === 'injection') {
    return truncate(props.node.content || '注入消息', 84)
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
  if (props.node.type === 'injection') {
    return truncate(props.node.content, 72)
  }
  return ''
})

const statusText = computed(() => {
  const text = {
    running: '执行中',
    success: '',
    error: '失败',
    stopped: '已停止',
    pending: '',
  }
  return text[normalizedStatus.value] ?? ''
})

const statusBadgeVariant = computed(() => {
  if (normalizedStatus.value === 'error') return 'destructive'
  if (normalizedStatus.value === 'stopped') return 'warning'
  return 'default'
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

watch(nodeKeyValue, () => {
  expanded.value = defaultExpanded(props.node)
})

const toolStatuses = computed(() => {
  if (props.node.type !== 'agent_call') return []
  const statuses = []
  collectToolStatuses(props.node.children || [], statuses)
  return statuses
})

const toolProgress = computed(() => toolStatuses.value.reduce((counts, status) => {
  const normalized = normalizeStatus(status)
  counts[normalized] = (counts[normalized] || 0) + 1
  return counts
}, { success: 0, running: 0, error: 0, stopped: 0, pending: 0 }))

const toolProgressText = computed(() => {
  const counts = toolProgress.value
  const parts = [`${counts.success}/${toolStatuses.value.length} 工具完成`]
  if (counts.running) parts.push(`${counts.running} 执行中`)
  if (counts.error) parts.push(`${counts.error} 失败`)
  if (counts.stopped) parts.push(`${counts.stopped} 已停止`)
  return parts.join(' · ')
})

const toolProgressTone = computed(() => {
  if (toolProgress.value.error) return 'error'
  if (toolProgress.value.running) return 'running'
  if (toolProgress.value.stopped) return 'warning'
  return 'muted'
})

watch(
  [titleText, subtitleText, toolProgressText, normalizedStatus],
  () => emit('layoutChange'),
  { flush: 'post' }
)

function handleSummaryClick() {
  emit('inspect', props.node)
}

function toggleExpanded() {
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
  emit('layoutChange')
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
  --etn-side-width: 110px;
  --rail-dot-top: 17px;
  --rail-dot-size: 9px;
  --rail-dot-center: calc(var(--rail-dot-top) + (var(--rail-dot-size) / 2));
  --branch-opacity: 0.48;
  position: relative;
  letter-spacing: 0;
  content-visibility: auto;
  contain-intrinsic-size: auto 54px;
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
  --etn-side-width: 96px;
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

.etn--agent_call {
  --etn-side-width: 94px;
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

.etn.status-running > .etn-row .etn-status-dot {
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.06),
    0 0 8px rgba(var(--color-brand-accent-rgb), 0.5);
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
    box-shadow var(--transition-fast),
    transform var(--transition-fast);
}

.etn-card.is-interactive:not(.is-selected):hover {
  border-color: var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.36);
  /* transform: translateY(-1px); */
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

.etn--agent_call > .etn-row .etn-card {
  border-color: color-mix(in srgb, var(--color-border) 62%, transparent);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.3);
}

.etn--agent_call > .etn-row .etn-card.is-interactive:not(.is-selected):hover {
  border-color: var(--color-border-hover);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.4);
}

.etn-card.is-selected,
.etn--nested .etn-card.is-selected,
.etn--tool_call .etn-card.is-selected,
.etn--nested.etn--tool_call .etn-card.is-selected {
  border-color: var(--selection-border);
  background: var(--selection-bg);
  box-shadow:
    inset 0 0 0 1px var(--selection-ring),
    0 0 10px rgba(var(--color-brand-accent-rgb), 0.06);
}

.etn-summary-shell {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.etn-summary {
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
  padding: 8px 4px 8px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
}

.etn-summary--leaf {
  padding-right: 10px;
}

.etn-summary:disabled {
  cursor: default;
}

.etn--tool_call .etn-summary {
  padding-top: 6px;
  padding-bottom: 6px;
}

.etn-expand-toggle {
  align-self: center;
  margin-right: 4px;
}

.etn-expand-toggle svg {
  transition: transform var(--transition-fast);
}

.etn-expand-toggle[data-state='open'] svg {
  transform: rotate(90deg);
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
  --type-color: var(--color-agent-violet);
  --type-rgb: var(--color-agent-violet-rgb);
}

.etn-type-icon.icon-thought {
  --type-color: var(--color-warning);
  --type-rgb: var(--color-warning-rgb);
}

.etn-type-icon.icon-tool {
  --type-color: var(--color-agent-default);
  --type-rgb: var(--color-agent-default-rgb);
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
  --type-color: var(--color-agent-cyan);
  --type-rgb: var(--color-agent-cyan-rgb);
}

.etn-type-icon.icon-globe {
  --type-color: var(--color-agent-blue);
  --type-rgb: var(--color-agent-blue-rgb);
}

.etn-type-icon.icon-map {
  --type-color: var(--color-agent-green);
  --type-rgb: var(--color-agent-green-rgb);
}

.etn-type-icon.icon-chart {
  --type-color: var(--color-agent-pink);
  --type-rgb: var(--color-agent-pink-rgb);
}

.etn-type-icon.icon-skill {
  --type-color: var(--color-agent-violet);
  --type-rgb: var(--color-agent-violet-rgb);
}

.etn-type-icon.icon-input {
  --type-color: var(--color-warning);
  --type-rgb: var(--color-warning-rgb);
}

.etn-type-icon.icon-database {
  --type-color: var(--color-agent-green);
  --type-rgb: var(--color-agent-green-rgb);
}

.etn-type-icon.icon-task {
  --type-color: var(--color-agent-orange);
  --type-rgb: var(--color-agent-orange-rgb);
}

.etn-type-icon.icon-agentCall {
  --type-color: var(--color-agent-violet);
  --type-rgb: var(--color-agent-violet-rgb);
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
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding-top: 1px;
  flex-shrink: 0;
}

.etn-time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-align: right;
}

.etn-status-badge {
  flex: 0 0 auto;
  min-width: 0;
  justify-content: center;
}

.etn--agent_call .etn-time {
  font-size: 10px;
}

.etn-status-success {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-success);
}

.etn-status-success svg {
  width: 13px;
  height: 13px;
}

.etn-agent-progress {
  display: flex;
  align-items: center;
  min-width: 0;
  padding-top: 1px;
  font-size: 10px;
  color: var(--color-text-muted);
  line-height: 1.25;
}

.etn-agent-progress.tone-running { color: var(--color-brand-accent); }
.etn-agent-progress.tone-error { color: var(--color-error); }
.etn-agent-progress.tone-warning { color: var(--color-warning); }

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
  transition: opacity 140ms ease;
}

.etn-status-enter-from {
  opacity: 0;
}

.etn-status-leave-to {
  opacity: 0;
}

.etn-expand-enter-active,
.etn-expand-leave-active {
  overflow: hidden;
}

@media (prefers-reduced-motion: reduce) {
  .etn-status-pulse {
    animation: none;
  }

  .etn-card.is-interactive:not(.is-selected):hover {
    transform: none;
  }

  .etn-status-dot,
  .etn-card,
  .etn-expand-toggle svg,
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
