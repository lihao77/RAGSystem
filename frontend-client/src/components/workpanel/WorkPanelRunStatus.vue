<template>
  <div class="wpr-root" :class="{ active: isActive }">
    <div class="wpr-phase-row">
      <span class="wpr-indicator" :class="`tone-${phaseTone}`" aria-hidden="true">
        <span class="wpr-indicator-core"></span>
      </span>
      <div class="wpr-label-block">
        <span class="wpr-kicker">当前状态</span>
        <Transition name="wpr-label" mode="out-in">
          <span :key="phaseLabel" class="wpr-label">{{ phaseLabel }}</span>
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

const props = defineProps({
  phase: { type: String, default: 'idle' },
  runStartedAt: { type: Number, default: null },
  contextUsage: { type: Object, default: () => ({ used: 0, max: 0 }) },
})

const PHASE_LABELS = {
  idle: '空闲',
  llm_waiting_first_token: '思考中',
  llm_streaming: '生成中',
  tool_running: '执行工具',
  background_waiting: '等待后台',
  retrying: '重试中',
  reflecting: '反思中',
  approval_waiting: '等待审批',
}

const phaseLabel = computed(() => PHASE_LABELS[props.phase] || props.phase)

const isActive = computed(() => props.phase !== 'idle')
const phaseTone = computed(() => {
  if (props.phase === 'approval_waiting') return 'warning'
  if (props.phase === 'retrying') return 'warning'
  if (props.phase === 'idle') return 'idle'
  return 'active'
})

const elapsed = ref(0)
let timer = null

function tick() {
  elapsed.value = props.runStartedAt ? Math.floor((Date.now() - props.runStartedAt) / 1000) : 0
}

onMounted(() => { timer = setInterval(tick, 1000); tick() })
onUnmounted(() => clearInterval(timer))
watch(() => props.runStartedAt, tick)

const elapsedText = computed(() => {
  if (!props.runStartedAt || !isActive.value) return ''
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
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex-shrink: 0;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.2);
  letter-spacing: 0;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}

.wpr-root.active {
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.3);
}

.wpr-phase-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.wpr-indicator {
  width: 30px;
  height: 30px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.42);
  flex-shrink: 0;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast),
    box-shadow var(--transition-fast);
}

.wpr-indicator-core {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--color-text-muted);
  box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.04);
  transition:
    background var(--transition-fast),
    box-shadow var(--transition-fast),
    transform var(--transition-fast),
    opacity var(--transition-fast);
}

.wpr-indicator.tone-active {
  border-color: rgba(var(--color-brand-accent-rgb), 0.24);
  background: rgba(var(--color-brand-accent-rgb), 0.1);
}

.wpr-indicator.tone-active .wpr-indicator-core {
  background: var(--color-brand-accent);
  box-shadow: 0 0 0 4px rgba(var(--color-brand-accent-rgb), 0.16);
  animation: wpr-pulse 1.6s ease-in-out infinite;
}

.wpr-indicator.tone-warning {
  border-color: rgba(var(--color-warning-rgb), 0.26);
  background: rgba(var(--color-warning-rgb), 0.1);
}

.wpr-indicator.tone-warning .wpr-indicator-core {
  background: var(--color-warning);
  box-shadow: 0 0 0 4px rgba(var(--color-warning-rgb), 0.14);
  animation: wpr-pulse 1.6s ease-in-out infinite;
}

@keyframes wpr-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.78); }
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
  font-size: 13px;
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
  gap: 6px 10px;
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
  height: 5px;
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
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.wpr-label-enter-active,
.wpr-label-leave-active,
.wpr-elapsed-enter-active,
.wpr-elapsed-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.wpr-label-enter-from,
.wpr-elapsed-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.wpr-label-leave-to,
.wpr-elapsed-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (prefers-reduced-motion: reduce) {
  .wpr-indicator.tone-active .wpr-indicator-core,
  .wpr-indicator.tone-warning .wpr-indicator-core {
    animation: none;
  }

  .wpr-root,
  .wpr-indicator,
  .wpr-indicator-core,
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
