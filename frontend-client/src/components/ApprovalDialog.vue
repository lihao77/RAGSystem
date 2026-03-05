<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="visible" class="approval-overlay" @click="handleOverlayClick">
        <div class="approval-container" @click.stop>
          <div class="approval-header">
            <div class="approval-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                <line x1="12" y1="9" x2="12" y2="13"></line>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
              </svg>
            </div>
            <h3 class="approval-title">权限确认</h3>
          </div>

          <div class="approval-body">
            <div class="approval-agent-info">
              <span class="label">智能体:</span>
              <span class="value">{{ agentName }}</span>
            </div>

            <div class="approval-action-box">
              <div class="action-label">请求执行操作:</div>
              <div class="action-description">{{ actionDescription }}</div>
            </div>

            <div v-if="toolName" class="approval-tool-info">
              <span class="tool-label">工具:</span>
              <span class="tool-name">{{ toolName }}</span>
              <span v-if="riskLevel" class="risk-badge" :class="`risk-${riskLevel.toLowerCase()}`">{{ riskLabel }}</span>
            </div>

            <div class="approval-warning">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <span>此操作可能修改数据或执行敏感命令，请谨慎确认</span>
            </div>
          </div>

          <div class="approval-footer">
            <button class="approval-btn approval-btn-deny" @click="handleDeny">
              拒绝
            </button>
            <button class="approval-btn approval-btn-approve" @click="handleApprove">
              允许执行
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed } from 'vue';

const emit = defineEmits(['approve', 'deny']);

const visible = ref(false);
const agentName = ref('');
const actionDescription = ref('');
const toolName = ref('');
const riskLevel = ref('');

let _approvalId = '';
let _onApprove = null;
let _onDeny = null;

const riskLabel = computed(() => {
  const map = { HIGH: '高风险', MEDIUM: '中风险', LOW: '低风险' };
  return map[riskLevel.value?.toUpperCase()] || riskLevel.value;
});

/**
 * 显示审批对话框
 * @param {object} data - { approval_id, tool_name, arguments, risk_level, description }
 * @param {function} onApprove - (approvalId) => void
 * @param {function} onDeny - (approvalId) => void
 */
const show = (data, onApprove, onDeny) => {
  _approvalId = data.approval_id || '';
  agentName.value = data.agent_name || '智能体';
  toolName.value = data.tool_name || '';
  riskLevel.value = data.risk_level || '';
  actionDescription.value = data.description || `请求执行工具: ${data.tool_name || '未知工具'}`;
  _onApprove = onApprove || null;
  _onDeny = onDeny || null;
  visible.value = true;
};

const hide = () => {
  visible.value = false;
};

const handleApprove = () => {
  hide();
  if (_onApprove) _onApprove(_approvalId);
  emit('approve', _approvalId);
};

const handleDeny = () => {
  hide();
  if (_onDeny) _onDeny(_approvalId);
  emit('deny', _approvalId);
};

// 点击遮罩不关闭，强制用户做出选择
const handleOverlayClick = () => {};

defineExpose({ show, hide });
</script>

<style scoped>
.approval-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: var(--spacing-md);
  animation: overlayFadeIn 0.2s ease;
}

@keyframes overlayFadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.approval-container {
  background: var(--color-bg-primary);
  border: 2px solid var(--color-warning);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 193, 7, 0.2);
  max-width: 480px;
  width: 100%;
  overflow: hidden;
  animation: containerSlideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes containerSlideIn {
  from { transform: scale(0.9) translateY(-20px); opacity: 0; }
  to   { transform: scale(1) translateY(0); opacity: 1; }
}

.approval-header {
  padding: var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  background: linear-gradient(135deg, rgba(255, 193, 7, 0.1) 0%, transparent 100%);
}

.approval-icon {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--color-warning);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-bg-primary);
  flex-shrink: 0;
}

.approval-title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.approval-body {
  padding: var(--spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.approval-agent-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
}

.approval-agent-info .label {
  color: var(--color-text-secondary);
  font-weight: 500;
}

.approval-agent-info .value {
  color: var(--color-text-primary);
  font-weight: 600;
  font-family: 'Courier New', monospace;
}

.approval-action-box {
  padding: var(--spacing-md);
  background: var(--color-bg-secondary);
  border-left: 3px solid var(--color-warning);
  border-radius: var(--radius-sm);
}

.action-label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-text-secondary);
  margin-bottom: var(--spacing-xs);
  font-weight: 600;
}

.action-description {
  font-size: 0.9375rem;
  line-height: 1.6;
  color: var(--color-text-primary);
  font-weight: 500;
}

.approval-tool-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 0.875rem;
}

.tool-label {
  color: var(--color-text-secondary);
}

.tool-name {
  font-family: 'Courier New', monospace;
  color: var(--color-text-primary);
  font-weight: 600;
}

.risk-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
}

.risk-badge.risk-high {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.risk-badge.risk-medium {
  background: rgba(255, 193, 7, 0.15);
  color: var(--color-warning);
  border: 1px solid rgba(255, 193, 7, 0.3);
}

.risk-badge.risk-low {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.approval-warning {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background: rgba(255, 193, 7, 0.1);
  border: 1px solid rgba(255, 193, 7, 0.3);
  border-radius: var(--radius-sm);
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--color-warning);
}

.approval-warning svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.approval-footer {
  padding: var(--spacing-md) var(--spacing-lg) var(--spacing-lg);
  display: flex;
  gap: var(--spacing-sm);
  justify-content: flex-end;
}

.approval-btn {
  padding: 12px 24px;
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--transition-fast);
  border: none;
  outline: none;
  flex: 1;
}

.approval-btn-deny {
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
}

.approval-btn-deny:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  border-color: var(--color-text-secondary);
}

.approval-btn-approve {
  background: var(--color-warning);
  color: var(--color-bg-primary);
}

.approval-btn-approve:hover {
  background: #f59e0b;
  box-shadow: 0 0 16px rgba(255, 193, 7, 0.5);
  transform: translateY(-1px);
}

.approval-btn:active {
  transform: scale(0.98);
}

/* 动画 */
.dialog-fade-enter-active,
.dialog-fade-leave-active {
  transition: opacity 0.2s ease;
}
.dialog-fade-enter-from,
.dialog-fade-leave-to {
  opacity: 0;
}

/* 移动端适配 */
@media (max-width: 767px) {
  .approval-container {
    max-width: calc(100vw - 32px);
  }
  .approval-header {
    padding: var(--spacing-md);
  }
  .approval-body {
    padding: var(--spacing-md);
  }
  .approval-footer {
    padding: var(--spacing-sm) var(--spacing-md) var(--spacing-md);
    flex-direction: column-reverse;
  }
  .approval-btn {
    width: 100%;
  }
}
</style>
