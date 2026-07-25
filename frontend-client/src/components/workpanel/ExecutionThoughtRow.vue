<template>
  <div
    class="etr"
    :class="[`status-${status}`, { 'etr--selected': isSelected, 'etr--nested': depth > 0 }]"
    :data-node-key="nodeKeyValue"
  >
    <button type="button" class="etr-row" :aria-expanded="expandable ? expanded : undefined" @click="handleClick">
      <span class="etr-text" :class="{ 'is-clamped': !expanded }">{{ intentText }}</span>
      <span v-if="expandable" class="etr-toggle" aria-hidden="true">
        <svg viewBox="0 0 20 20" width="12" height="12" :class="{ expanded }">
          <path d="M5 7l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </button>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import {
  getExecutionNodeKey as getNodeKey,
  normalizeExecutionStatus as normalizeStatus,
} from '../../utils/executionTreePresentation'

const props = defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
  selectedKey: { type: String, default: '' },
})
const emit = defineEmits(['inspect', 'layoutChange'])

const expanded = ref(false)

const status = computed(() => normalizeStatus(props.node.status))
const isRunning = computed(() => status.value === 'running')
const nodeKeyValue = computed(() => getNodeKey(props.node))
const isSelected = computed(() => Boolean(props.selectedKey && props.selectedKey === nodeKeyValue.value))

const intentText = computed(() => {
  const intent = props.node.intent || props.node.thought || props.node.thinking || ''
  if (intent) return String(intent).trim()
  if (isRunning.value) return '思考中…'
  return props.node.round != null ? `轮次 ${props.node.round}` : '执行记录'
})

// 超过约 3 行才显示"展开"小箭头(按字符粗判,中文约每行 26 字)。
const expandable = computed(() => intentText.value.length > 80)

watch([expanded, intentText], () => emit('layoutChange'), { flush: 'post' })

function handleClick() {
  if (expandable.value) {
    expanded.value = !expanded.value
    return
  }
  emit('inspect', props.node)
}
</script>

<style scoped>
.etr {
  position: relative;
  letter-spacing: 0;
  margin: 2px 0;
  content-visibility: auto;
  contain-intrinsic-size: auto 24px;
}

/* 段标题:上方多留间距,把它和上一段行动隔开,自然形成小节 */
.etr-row {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px 2px 4px;
  margin-top: 4px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.etr:first-child .etr-row { margin-top: 0; }

.etr-row:hover { background: rgba(var(--color-warning-rgb), 0.05); }

.etr--selected > .etr-row {
  background: rgba(var(--color-brand-accent-rgb), 0.07);
  box-shadow: inset 0 0 0 1px rgba(var(--color-brand-accent-rgb), 0.24);
}

.etr-text {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  line-height: 1.5;
  font-style: italic;
  color: var(--color-warning);
  opacity: 0.85;
  overflow-wrap: anywhere;
}

/* 运行中的思考:斜体微微呼吸,提示"正在想" */
.etr.status-running .etr-text {
  opacity: 1;
  animation: etr-breathe 1.8s ease-in-out infinite;
}

@keyframes etr-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.etr-text.is-clamped {
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.etr-toggle {
  flex-shrink: 0;
  display: inline-flex;
  color: var(--color-text-muted);
  margin-top: 2px;
  transition: transform var(--transition-fast);
}

.etr-toggle svg.expanded { transform: rotate(180deg); }

@media (prefers-reduced-motion: reduce) {
  .etr.status-running .etr-text { animation: none; }
  .etr-row, .etr-toggle { transition-duration: 1ms; }
}
</style>
