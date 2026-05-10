<template>
  <div class="wpr-root">
    <div class="wpr-phase-row">
      <span class="wpr-icon">{{ phaseIcon }}</span>
      <span class="wpr-label">{{ phaseLabel }}</span>
      <span v-if="elapsedText" class="wpr-elapsed">{{ elapsedText }}</span>
    </div>
    <div v-if="contextUsage.max > 0" class="wpr-ctx-row">
      <div class="wpr-ctx-bar-track">
        <div class="wpr-ctx-bar-fill" :class="ctxClass" :style="{ width: ctxPercent + '%' }"></div>
      </div>
      <span class="wpr-ctx-label">{{ contextUsage.used.toLocaleString() }} / {{ contextUsage.max.toLocaleString() }}</span>
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

const PHASE_ICONS = {
  idle: '○',
  llm_waiting_first_token: '◌',
  llm_streaming: '▶',
  tool_running: '⚙',
  background_waiting: '⏳',
  retrying: '↻',
  reflecting: '◎',
  approval_waiting: '◈',
}

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

const phaseIcon = computed(() => PHASE_ICONS[props.phase] || '○')
const phaseLabel = computed(() => PHASE_LABELS[props.phase] || props.phase)

const isActive = computed(() => props.phase !== 'idle')

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
</script>

<style scoped>
.wpr-root {
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}

.wpr-phase-row {
  display: flex;
  align-items: center;
  gap: 7px;
}

.wpr-icon {
  font-size: 14px;
  color: v-bind("isActive ? 'var(--color-brand-accent)' : 'var(--color-text-muted)'");
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  animation: v-bind("isActive && phase !== 'idle' ? 'wpr-pulse 2s ease-in-out infinite' : 'none'");
}

@keyframes wpr-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.wpr-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  flex: 1;
}

.wpr-elapsed {
  font-size: 12px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.wpr-ctx-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wpr-ctx-bar-track {
  flex: 1;
  height: 3px;
  background: var(--color-border);
  border-radius: 2px;
  overflow: hidden;
}

.wpr-ctx-bar-fill {
  height: 100%;
  border-radius: 2px;
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
</style>
