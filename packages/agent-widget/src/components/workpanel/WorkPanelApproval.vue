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
          {{ submitting ? '…' : '允许' }}
        </button>
        <button class="wpa-btn wpa-btn--deny" :disabled="submitting" @click="submit(false)">
          {{ submitting ? '…' : '拒绝' }}
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
const submitting = computed(() => !!props.submittingId && props.submittingId === currentApproval.value?.approval_id)
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
  emit('submit', { approvalId: approval.approval_id, approved, message: noteText.value })
  noteText.value = ''
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
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 12px);
  overflow: hidden;
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-lg);
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
  color: var(--color-warning);
}

.wpa-section-icon {
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm, 5px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--color-warning);
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
  border-radius: var(--radius-full);
  background: var(--color-warning);
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
  border-radius: var(--radius-full);
  letter-spacing: 0.01em;
  flex-shrink: 0;
}

.risk-low    { background: rgba(var(--color-success-rgb), 0.18); color: var(--color-success); }
.risk-medium { background: rgba(var(--color-warning-rgb), 0.18); color: var(--color-warning); }
.risk-high, .risk-critical { background: rgba(var(--color-error-rgb), 0.18); color: var(--color-error); }

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
  background: var(--color-bg-secondary);
  padding: 8px 11px;
  max-height: 100px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  border-radius: var(--radius-sm);
}

.wpa-note {
  width: auto;
  margin: 0 18px 14px;
  font-size: 13px;
  padding: 9px 12px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  outline: none;
  box-sizing: border-box;
  transition: border-color var(--transition-fast);
}

.wpa-note::placeholder { color: var(--color-text-muted); }
.wpa-note:focus {
  border-color: var(--color-warning);
}

.wpa-actions {
  display: flex;
  gap: 10px;
  padding: 0 18px 16px;
}

/* 按钮对齐系统 btn-send / btn-stop 风格，不另搞苹果 filled */
.wpa-btn {
  flex: 1;
  padding: 9px 18px;
  border-radius: var(--radius-md);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  border: 1px solid transparent;
  background: transparent;
}
.wpa-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.wpa-btn:active:not(:disabled) { transform: scale(0.97); }

.wpa-btn--approve {
  background: var(--color-success);
  color: var(--color-on-color);
  box-shadow: 0 2px 12px rgba(var(--color-success-rgb), 0.3);
}
.wpa-btn--approve:hover:not(:disabled) {
  filter: brightness(1.08);
  box-shadow: 0 4px 20px rgba(var(--color-success-rgb), 0.45);
  transform: translateY(-1px);
}

.wpa-btn--deny {
  color: var(--color-error);
  border-color: var(--color-border);
}
.wpa-btn--deny:hover:not(:disabled) {
  border-color: var(--color-error);
  background: rgba(var(--color-error-rgb), 0.08);
  transform: translateY(-1px);
}</style>
