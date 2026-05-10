<template>
  <div class="wpr-root" :class="[`tone-${displayTone}`, { active: isEmphasized }]">
    <div class="wpr-phase-row">
      <span class="wpr-indicator" aria-hidden="true">
        <WorkPanelStateIcon :kind="displayIcon" />
      </span>
      <div class="wpr-label-block">
        <span class="wpr-kicker">工作栏</span>
        <Transition name="wpr-label" mode="out-in">
          <span :key="displayLabel" class="wpr-label">{{ displayLabel }}</span>
        </Transition>
      </div>
      <Transition name="wpr-elapsed">
        <span v-if="elapsedText" class="wpr-elapsed">{{ elapsedText }}</span>
      </Transition>
    </div>
    <div v-if="contextUsage.max > 0" class="wpr-ctx-row">
      <div class="wpr-ctx-copy">
        <span>上下文</span>
        <span>{{ ctxPercent }}%</span>
      </div>
      <div class="wpr-ctx-bar-track" :title="`${contextUsage.used.toLocaleString()} / ${contextUsage.max.toLocaleString()} tokens`">
        <div class="wpr-ctx-bar-fill" :class="ctxClass" :style="{ width: ctxPercent + '%' }"></div>
      </div>
      <span class="wpr-ctx-label">{{ compactNumber(contextUsage.used) }} / {{ compactNumber(contextUsage.max) }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import WorkPanelStateIcon from './WorkPanelStateIcon.vue'

const props = defineProps({
  phase: { type: String, default: 'idle' },
  runStartedAt: { type: Number, default: null },
  contextUsage: { type: Object, default: () => ({ used: 0, max: 0 }) },
  pendingInput: { type: Boolean, default: false },
  approvalCount: { type: Number, default: 0 },
  hasError: { type: Boolean, default: false },
  completed: { type: Boolean, default: false },
})

const PHASE_LABELS = {
  idle: '待命',
  llm_waiting_first_token: '等待模型响应',
  llm_streaming: '模型输出中',
  tool_running: '工具执行中',
  background_waiting: '等待后台任务',
  retrying: '重试中',
  reflecting: '反思中',
  approval_waiting: '等待审批',
}

const displayState = computed(() => {
  if (props.pendingInput) return { label: '待输入', tone: 'input', icon: 'input' }
  if (props.approvalCount > 0 || props.phase === 'approval_waiting') return { label: '等待审批', tone: 'warning', icon: 'approval' }
  if (props.hasError) return { label: '执行异常', tone: 'error', icon: 'error' }
  if (props.phase === 'retrying') return { label: '重试中', tone: 'warning', icon: 'approval' }
  if (props.phase && props.phase !== 'idle') {
    return { label: PHASE_LABELS[props.phase] || props.phase, tone: 'running', icon: 'running' }
  }
  if (props.completed) return { label: '已完成', tone: 'success', icon: 'success' }
  return { label: '待命', tone: 'idle', icon: 'idle' }
})

const displayLabel = computed(() => displayState.value.label)
const displayTone = computed(() => displayState.value.tone)
const displayIcon = computed(() => displayState.value.icon)
const isRuntimeActive = computed(() => props.phase !== 'idle')
const isEmphasized = computed(() => displayTone.value !== 'idle')

const elapsed = ref(0)
let timer = null

const startedAtMs = computed(() => {
  const value = Number(props.runStartedAt)
  if (!Number.isFinite(value) || value <= 0) return 0
  return value < 10000000000 ? value * 1000 : value
})

function tick() {
  elapsed.value = startedAtMs.value ? Math.max(0, Math.floor((Date.now() - startedAtMs.value) / 1000)) : 0
}

onMounted(() => { timer = setInterval(tick, 1000); tick() })
onUnmounted(() => clearInterval(timer))
watch(() => props.runStartedAt, tick)

const elapsedText = computed(() => {
  if (!startedAtMs.value || !isRuntimeActive.value) return ''
  const s = elapsed.value
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`
})

const ctxPercent = computed(() => {
  if (!props.contextUsage.max) return 0
  return Math.min(100, Math.round(props.contextUsage.used / props.contextUsage.max * 100))
})

const ctxClass = computed(() => {
  const p = ctxPercent.value
  if (p >= 90) return 'fill-danger'
  if (p >= 70) return 'fill-warning'
  return 'fill-ok'
})

function compactNumber(value) {
  const n = Number(value || 0)
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}m`
  if (n >= 10000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return n.toLocaleString()
}
</script>

<style scoped>
.wpr-root {
  --wpr-tone-color: var(--color-text-muted);
  --wpr-tone-rgb: var(--color-text-muted-rgb, 142, 142, 147);
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.2);
  letter-spacing: 0;
}

.wpr-root.active {
  background:
    linear-gradient(90deg, rgba(var(--wpr-tone-rgb), 0.055), transparent 58%),
    rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.26);
}

.wpr-root.tone-running,
.wpr-root.tone-input {
  --wpr-tone-color: var(--color-brand-accent);
  --wpr-tone-rgb: var(--color-brand-accent-rgb);
}

.wpr-root.tone-warning {
  --wpr-tone-color: var(--color-warning);
  --wpr-tone-rgb: var(--color-warning-rgb);
}

.wpr-root.tone-error {
  --wpr-tone-color: var(--color-error);
  --wpr-tone-rgb: var(--color-error-rgb);
}

.wpr-root.tone-success {
  --wpr-tone-color: var(--color-success);
  --wpr-tone-rgb: var(--color-success-rgb);
}

.wpr-phase-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wpr-indicator {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(var(--wpr-tone-rgb), 0.2);
  background: rgba(var(--wpr-tone-rgb), 0.07);
  color: var(--wpr-tone-color);
  flex-shrink: 0;
}

.wpr-root.tone-idle .wpr-indicator {
  border-color: var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.36);
}

.wpr-indicator :deep(svg) {
  width: 14px;
  height: 14px;
}

.wpr-label-block {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 1px;
  flex: 1;
}

.wpr-kicker {
  font-size: 10px;
  line-height: 1.2;
  color: var(--color-text-muted);
  font-weight: 650;
}

.wpr-label {
  font-size: 12px;
  line-height: 1.35;
  font-weight: 650;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wpr-elapsed {
  font-size: 12px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.wpr-ctx-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 10px;
}

.wpr-ctx-copy {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  line-height: 1.2;
  color: var(--color-text-muted);
}

.wpr-ctx-bar-track {
  flex: 1;
  height: 4px;
  background: var(--color-border);
  border-radius: var(--radius-full);
  overflow: hidden;
  align-self: center;
}

.wpr-ctx-bar-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width 0.5s ease;
}

.fill-ok { background: var(--color-success, #22c55e); }
.fill-warning { background: var(--color-warning, #f59e0b); }
.fill-danger { background: var(--color-error, #ef4444); }

.wpr-ctx-label {
  font-size: 10px;
  color: var(--color-text-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.wpr-label-enter-active,
.wpr-label-leave-active,
.wpr-elapsed-enter-active,
.wpr-elapsed-leave-active {
  transition: opacity 140ms ease;
}

.wpr-label-enter-from,
.wpr-elapsed-enter-from {
  opacity: 0;
}

.wpr-label-leave-to,
.wpr-elapsed-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .wpr-ctx-bar-fill,
  .wpr-label-enter-active,
  .wpr-label-leave-active,
  .wpr-elapsed-enter-active,
  .wpr-elapsed-leave-active {
    transition-duration: 1ms;
  }

  .wpr-label-enter-from,
  .wpr-label-leave-to,
  .wpr-elapsed-enter-from,
  .wpr-elapsed-leave-to {
    transform: none;
  }
}
</style>
