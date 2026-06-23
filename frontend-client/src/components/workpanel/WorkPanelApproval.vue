<template>
  <div v-if="currentApproval" class="wpa-root">
    <div class="wpa-card">
      <div class="wpa-section-label">
        <span class="wpa-section-icon" aria-hidden="true">
          <WorkPanelStateIcon kind="approval" />
        </span>
        <span>待审批</span>
        <span v-if="queue.length > 1" class="wpa-queue-badge">{{ queue.length }}</span>
      </div>

      <!-- Tool + risk -->
      <div class="wpa-card-header">
        <span class="wpa-tool-name">{{ currentApproval.tool_name }}</span>
        <span class="wpa-risk-badge" :class="`risk-${currentApproval.risk_level || 'low'}`">
          {{ riskLabel(currentApproval.risk_level) }}
        </span>
      </div>

      <!-- Agent -->
      <div v-if="currentApproval.agent_name" class="wpa-agent">
        {{ currentApproval.agent_name }}
      </div>

      <!-- Reason -->
      <div v-if="currentApproval.approval_reason" class="wpa-reason">
        {{ currentApproval.approval_reason }}
      </div>

      <!-- Args (collapsible) -->
      <div v-if="hasArgs">
        <button class="wpa-toggle" @click="showArgs = !showArgs">
          参数 <span class="wpa-chevron" :class="{ open: showArgs }">›</span>
        </button>
        <pre v-if="showArgs" class="wpa-pre">{{ formattedArgs }}</pre>
      </div>

      <!-- Note -->
      <input
        v-model="noteText"
        class="wpa-note"
        placeholder="附言（可选）"
        :disabled="submitting"
      />

      <!-- Actions -->
      <div class="wpa-actions">
        <button class="wpa-btn wpa-btn--approve" :disabled="submitting" @click="submit(true)">
          {{ submitting && pendingApproved === true ? '…' : '允许' }}
        </button>
        <button class="wpa-btn wpa-btn--deny" :disabled="submitting" @click="submit(false)">
          {{ submitting && pendingApproved === false ? '…' : '拒绝' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import WorkPanelStateIcon from './WorkPanelStateIcon.vue'

const props = defineProps({
  queue: { type: Array, default: () => [] },
  submittingId: { type: String, default: '' },
})
const emit = defineEmits(['submit'])

const currentApproval = computed(() => props.queue[0] || null)
const submitting = computed(() => !!props.submittingId)
const pendingApproved = ref(null)
const showArgs = ref(false)
const noteText = ref('')

const hasArgs = computed(() => {
  const a = currentApproval.value?.arguments
  if (!a) return false
  if (typeof a === 'object') return Object.keys(a).length > 0
  return String(a).trim().length > 0
})

const formattedArgs = computed(() => {
  const a = currentApproval.value?.arguments
  if (!a) return ''
  try {
    return JSON.stringify(typeof a === 'string' ? JSON.parse(a) : a, null, 2).slice(0, 1000)
  } catch {
    return String(a).slice(0, 1000)
  }
})

const RISK_LABELS = { low: '低风险', medium: '中风险', high: '高风险', critical: '极高风险' }
function riskLabel(level) { return RISK_LABELS[level] || level || '未知' }

function submit(approved) {
  const approval = currentApproval.value
  if (!approval?.approval_id || submitting.value) return
  pendingApproved.value = approved
  emit('submit', { approvalId: approval.approval_id, approved, message: noteText.value })
  noteText.value = ''
  pendingApproved.value = null
}
</script>

<style scoped>
.wpa-root {
  padding: 6px 14px 14px;
  background: transparent;
  letter-spacing: 0;
}

/* 苹果风卡片：实色 + 大圆角 + 柔和多层阴影，靠阴影和留白分层，不用 border/横线 */
.wpa-card {
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 16px;
  overflow: hidden;
  background: var(--color-bg-elevated, #1c1c1e);
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.06),
    0 6px 16px rgba(0, 0, 0, 0.16),
    0 18px 44px rgba(0, 0, 0, 0.24);
  display: flex;
  flex-direction: column;
}

.wpa-section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 15px 18px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--color-warning, #f59e0b);
}

.wpa-section-icon {
  width: 16px;
  height: 16px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--color-warning, #f59e0b);
  background: rgba(var(--color-warning-rgb), 0.16);
}

.wpa-section-icon :deep(svg) {
  width: 11px;
  height: 11px;
}

.wpa-queue-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--color-warning, #f59e0b);
  color: #1c1c1e;
  font-size: 10px;
  font-weight: 700;
}

.wpa-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 18px 13px;
}

.wpa-tool-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wpa-risk-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 999px;
  letter-spacing: 0.01em;
  flex-shrink: 0;
}

.risk-low    { background: rgba(34,197,94,0.18); color: var(--color-success, #22c55e); }
.risk-medium { background: rgba(245,158,11,0.18); color: var(--color-warning, #f59e0b); }
.risk-high, .risk-critical { background: rgba(239,68,68,0.18); color: var(--color-error, #ef4444); }

.wpa-agent {
  font-size: 12px;
  color: var(--color-text-muted);
  padding: 0 18px 3px;
}

.wpa-reason {
  font-size: 13px;
  color: var(--color-text-secondary);
  line-height: 1.45;
  padding: 3px 18px 13px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.wpa-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-muted);
  background: none;
  border: none;
  padding: 0 18px 6px;
  cursor: pointer;
}

.wpa-chevron {
  display: inline-block;
  font-size: 13px;
  transition: transform 0.2s;
}
.wpa-chevron.open { transform: rotate(90deg); }

.wpa-pre {
  margin: 0 18px 12px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
  background: rgba(255, 255, 255, 0.05);
  padding: 8px 11px;
  max-height: 100px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  border-radius: 9px;
}

.wpa-note {
  width: auto;
  margin: 0 18px 14px;
  font-size: 13px;
  padding: 9px 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  color: var(--color-text-primary);
  outline: none;
  box-sizing: border-box;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.wpa-note::placeholder { color: var(--color-text-muted); }
.wpa-note:focus {
  border-color: rgba(var(--color-warning-rgb, 245, 158, 11), 0.55);
  background: rgba(255, 255, 255, 0.08);
}

.wpa-actions {
  display: flex;
  gap: 10px;
  padding: 0 18px 16px;
}

/* 苹果风按钮：filled 实心（主操作绿、destructive 红），大圆角连续角，hover 亮度变化 */
.wpa-btn {
  flex: 1;
  padding: 11px 0;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  border-radius: 11px;
  background: transparent;
  transition: filter 0.12s, transform 0.1s;
}
.wpa-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.wpa-btn:active:not(:disabled) { transform: scale(0.97); }

.wpa-btn--approve {
  background: var(--color-success, #22c55e);
  color: #fff;
}
.wpa-btn--approve:hover:not(:disabled) {
  filter: brightness(1.08);
}

.wpa-btn--deny {
  background: color-mix(in srgb, var(--color-bg-elevated, #1c1c1e) 84%, var(--color-error, #ef4444) 16%);
  color: var(--color-error, #ef4444);
}
.wpa-btn--deny:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-bg-elevated, #1c1c1e) 72%, var(--color-error, #ef4444) 28%);
}
</style>
