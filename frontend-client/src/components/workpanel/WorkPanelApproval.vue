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
  padding: 6px 14px 12px;
  background: transparent;
  letter-spacing: 0;
}

/* 卡片：实色 + 左侧审批色条（替代多条横线作视觉标识）+ 双层阴影浮起 */
.wpa-card {
  position: relative;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 10px);
  overflow: hidden;
  background: var(--color-bg-elevated, #1c1c1e);
  box-shadow:
    0 14px 36px rgba(0, 0, 0, 0.46),
    0 3px 10px rgba(0, 0, 0, 0.26);
  display: flex;
  flex-direction: column;
}

.wpa-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: linear-gradient(180deg, var(--color-warning, #f59e0b), rgba(var(--color-warning-rgb, 245, 158, 11), 0.35));
}

.wpa-section-label {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 11px 14px 3px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--color-warning, #f59e0b);
}

.wpa-section-icon {
  width: 18px;
  height: 18px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--color-warning, #f59e0b);
  background: rgba(var(--color-warning-rgb), 0.12);
  border: 1px solid rgba(var(--color-warning-rgb), 0.22);
}

.wpa-section-icon :deep(svg) {
  width: 12px;
  height: 12px;
}

.wpa-queue-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--color-warning, #f59e0b);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
}

.wpa-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 14px 11px;
}

.wpa-tool-name {
  font-size: 13px;
  font-weight: 650;
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
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 20px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  flex-shrink: 0;
}

.risk-low    { background: rgba(34,197,94,0.14); color: var(--color-success, #22c55e); }
.risk-medium { background: rgba(245,158,11,0.14); color: var(--color-warning, #f59e0b); }
.risk-high, .risk-critical { background: rgba(239,68,68,0.14); color: var(--color-error, #ef4444); }

.wpa-agent {
  font-size: 11px;
  color: var(--color-text-muted);
  padding: 0 14px 3px;
}

.wpa-reason {
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.5;
  padding: 0 14px 10px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.wpa-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
  background: none;
  border: none;
  padding: 0 14px 4px;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.wpa-chevron {
  display: inline-block;
  font-size: 13px;
  transition: transform 0.2s;
}
.wpa-chevron.open { transform: rotate(90deg); }

/* 参数块：独立圆角浅块，不再用全宽 border-top 分隔 */
.wpa-pre {
  margin: 0 14px 10px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
  background: rgba(255, 255, 255, 0.04);
  padding: 7px 10px;
  max-height: 100px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  border-radius: 6px;
}

/* 附言：独立输入框（边框 + 圆角），不再用全宽 border-top */
.wpa-note {
  width: auto;
  margin: 4px 14px 10px;
  font-size: 12px;
  padding: 7px 10px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.22);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text-primary);
  outline: none;
  box-sizing: border-box;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.wpa-note::placeholder { color: var(--color-text-muted); }
.wpa-note:focus {
  border-color: rgba(var(--color-warning-rgb, 245, 158, 11), 0.5);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.32);
}

/* 操作区：按钮各自独立（边框 + 圆角 + 色调），gap 分隔，不再用 border-top/border-right */
.wpa-actions {
  display: flex;
  gap: 8px;
  padding: 0 14px 12px;
}

.wpa-btn {
  flex: 1;
  padding: 8px 0;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: transparent;
  transition: background 0.12s, transform 0.1s, border-color 0.12s;
}
.wpa-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.wpa-btn:active:not(:disabled) { transform: scale(0.97); }

.wpa-btn--approve {
  color: var(--color-success, #22c55e);
  border-color: rgba(34, 197, 94, 0.32);
}
.wpa-btn--approve:hover:not(:disabled) {
  background: rgba(34, 197, 94, 0.1);
  border-color: rgba(34, 197, 94, 0.44);
}
.wpa-btn--approve:active:not(:disabled) {
  background: rgba(34, 197, 94, 0.16);
}

.wpa-btn--deny {
  color: var(--color-error, #ef4444);
  border-color: rgba(239, 68, 68, 0.32);
}
.wpa-btn--deny:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.44);
}
.wpa-btn--deny:active:not(:disabled) {
  background: rgba(239, 68, 68, 0.16);
}
</style>
