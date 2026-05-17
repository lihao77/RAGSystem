<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="visible && !collapsed" class="approval-overlay" @click="handleOverlayClick">
        <div class="approval-container" @click.stop>
          <div class="approval-header">
            <div class="approval-header-main">
              <div class="approval-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                  <line x1="12" y1="9" x2="12" y2="13"></line>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
              </div>
              <div class="approval-title-wrap">
                <h3 class="approval-title">权限确认</h3>
                <p class="approval-subtitle">可先折叠窗口，继续查看 AI 实时进展</p>
              </div>
            </div>
            <button class="approval-header-action" type="button" @click="toggleCollapsed" title="折叠审批窗口">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 12H4"></path>
              </svg>
              <span>折叠</span>
            </button>
          </div>

          <div class="approval-body">
            <!-- 智能体 + 工具名 -->
            <div class="approval-meta-row">
              <div class="meta-item">
                <span class="meta-label">智能体</span>
                <span class="meta-value">{{ agentName }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">工具</span>
                <span class="meta-value mono">{{ toolName }}</span>
                <span v-if="riskLevel" class="risk-badge" :class="`risk-${riskLevel.toLowerCase()}`">{{ riskLabel }}</span>
              </div>
            </div>

            <!-- 操作描述 -->
            <div class="approval-action-box">
              <div class="action-label">操作说明</div>
              <div class="action-description">{{ actionDescription }}</div>
            </div>

            <div v-if="hasPermissionMode || hasApprovalReason || hasApprovalReasonLabels || hasApprovalSecondaryReasons || hasApprovedExternalPaths" class="approval-extra-box">
              <div v-if="hasApprovalReasonLabels" class="approval-extra-item">
                <span class="approval-extra-label">审批类别</span>
                <span class="approval-extra-value">{{ approvalReasonLabels.join(' + ') }}</span>
              </div>
              <div v-if="hasPermissionMode" class="approval-extra-item">
                <span class="approval-extra-label">当前权限模式</span>
                <span class="approval-extra-value">{{ permissionModeLabel }}</span>
              </div>
              <div v-if="hasApprovalReason" class="approval-extra-item">
                <span class="approval-extra-label">主要触发原因</span>
                <span class="approval-extra-value">{{ approvalReasonText }}</span>
              </div>
              <div v-if="hasApprovalSecondaryReasons" class="approval-extra-item approval-extra-item-stack">
                <span class="approval-extra-label">附加原因</span>
                <div class="approval-extra-list">
                  <div v-for="reason in approvalSecondaryReasons" :key="reason" class="approval-extra-list-item">{{ reason }}</div>
                </div>
              </div>
              <div v-if="hasApprovedExternalPaths" class="approval-extra-item approval-extra-item-stack">
                <span class="approval-extra-label">本次授权路径</span>
                <div class="approval-extra-list">
                  <div v-for="path in approvedExternalPaths" :key="path" class="approval-extra-list-item mono">{{ path }}</div>
                </div>
              </div>
            </div>

            <!-- 调用参数 -->
            <div v-if="hasArguments" class="approval-args-box">
              <div class="args-label">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="16 18 22 12 16 6"></polyline>
                  <polyline points="8 6 2 12 8 18"></polyline>
                </svg>
                调用参数
              </div>
              <pre class="args-content">{{ formattedArguments }}</pre>
            </div>

            <!-- 警告提示 -->
            <div class="approval-warning">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <span>此操作可能修改数据或执行敏感命令，请谨慎确认</span>
            </div>

            <!-- 审批模式切换 -->
            <div class="approval-mode-tabs">
              <button
                class="mode-tab"
                :class="{ active: activeMode === 'approve' }"
                @click="activeMode = 'approve'"
              >允许执行</button>
              <button
                class="mode-tab mode-tab-deny"
                :class="{ active: activeMode === 'deny' }"
                @click="activeMode = 'deny'"
              >拒绝</button>
            </div>

            <!-- 批准附言 -->
            <div v-if="activeMode === 'approve'" class="approval-message-box">
              <label class="message-label">附加提示（可选）</label>
              <textarea
                v-model="approveMessage"
                class="message-textarea"
                placeholder="可向智能体补充说明，例如：请特别注意备份现有数据…"
                rows="2"
              ></textarea>
            </div>

            <!-- 拒绝理由 -->
            <div v-if="activeMode === 'deny'" class="approval-message-box denial">
              <label class="message-label">拒绝理由 / 后续指令（可选）</label>
              <textarea
                v-model="denyMessage"
                class="message-textarea"
                placeholder="可告诉智能体原因或指定下一步，例如：请改用只读方式查询…"
                rows="2"
              ></textarea>
            </div>
          </div>

          <div class="approval-footer">
            <button
              v-if="activeMode === 'approve'"
              class="approval-btn approval-btn-approve"
              @click="handleApprove"
            >确认允许执行</button>
            <button
              v-if="activeMode === 'deny'"
              class="approval-btn approval-btn-deny"
              @click="handleDeny"
            >确认拒绝</button>
          </div>
        </div>
      </div>
    </Transition>

    <Transition name="approval-dock-fade">
      <button
        v-if="visible && collapsed"
        class="approval-dock"
        type="button"
        :title="`待审批 ${queueCount} 条，点击展开`"
        @click="toggleCollapsed"
      >
        <div class="approval-dock-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        </div>
        <span class="approval-dock-count">{{ queueCount }}</span>
      </button>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed } from 'vue';
import { getApprovalReasonLabels, getApprovalReasonText, getPermissionModeLabel } from '../utils/permissionPresentation';

const emit = defineEmits(['approve', 'deny']);

const visible = ref(false);
const collapsed = ref(false);
const agentName = ref('');
const actionDescription = ref('');
const toolName = ref('');
const riskLevel = ref('');
const toolArguments = ref(null);
const permissionMode = ref('');
const approvalReason = ref('');
const approvalReasonCodes = ref([]);
const approvalSecondaryReasons = ref([]);
const approvedExternalPaths = ref([]);
const queueCount = ref(1);
const activeMode = ref('approve');
const approveMessage = ref('');
const denyMessage = ref('');

let _approvalId = '';
let _onApprove = null;
let _onDeny = null;

const riskLabel = computed(() => {
  const map = { HIGH: '高风险', MEDIUM: '中风险', LOW: '低风险' };
  return map[riskLevel.value?.toUpperCase()] || riskLevel.value;
});

const permissionModeLabel = computed(() => getPermissionModeLabel(permissionMode.value));
const approvalReasonText = computed(() => getApprovalReasonText(approvalReason.value));
const approvalReasonLabels = computed(() => getApprovalReasonLabels(approvalReasonCodes.value));
const hasPermissionMode = computed(() => Boolean(permissionMode.value));
const hasApprovalReason = computed(() => Boolean(approvalReasonText.value));
const hasApprovalReasonLabels = computed(() => approvalReasonLabels.value.length > 0);
const hasApprovalSecondaryReasons = computed(() => approvalSecondaryReasons.value.length > 0);
const hasApprovedExternalPaths = computed(() => approvedExternalPaths.value.length > 0);

const hasArguments = computed(() => {
  if (!toolArguments.value) return false;
  return Object.keys(toolArguments.value).length > 0;
});

const formattedArguments = computed(() => {
  try {
    return JSON.stringify(toolArguments.value, null, 2);
  } catch {
    return String(toolArguments.value);
  }
});

/**
 * 显示审批对话框
 * @param {object} data - { approval_id, tool_name, arguments, risk_level, description, agent_name, permission_mode, approval_reason, approval_reason_codes, approval_secondary_reasons, approved_external_paths }
 * @param {function} onApprove - (approvalId, message) => void
 * @param {function} onDeny   - (approvalId, message) => void
 */
const show = (data, onApprove, onDeny) => {
  _approvalId = data.approval_id || '';
  agentName.value = data.agent_name || '智能体';
  toolName.value = data.tool_name || '';
  riskLevel.value = data.risk_level || '';
  actionDescription.value = data.description || `请求执行工具: ${data.tool_name || '未知工具'}`;
  toolArguments.value = data.arguments || null;
  permissionMode.value = data.permission_mode || '';
  approvalReason.value = data.approval_reason || '';
  approvalReasonCodes.value = Array.isArray(data.approval_reason_codes) ? data.approval_reason_codes : [];
  approvalSecondaryReasons.value = Array.isArray(data.approval_secondary_reasons) ? data.approval_secondary_reasons : [];
  approvedExternalPaths.value = Array.isArray(data.approved_external_paths) ? data.approved_external_paths : [];
  queueCount.value = Number.isFinite(data.queue_count) && data.queue_count > 0 ? data.queue_count : 1;
  activeMode.value = 'approve';
  approveMessage.value = '';
  denyMessage.value = '';
  collapsed.value = false;
  _onApprove = onApprove || null;
  _onDeny = onDeny || null;
  visible.value = true;
};

const hide = () => {
  visible.value = false;
  collapsed.value = false;
};

const toggleCollapsed = () => {
  collapsed.value = !collapsed.value;
};

const handleApprove = () => {
  const msg = approveMessage.value.trim();
  hide();
  if (_onApprove) _onApprove(_approvalId, msg);
  emit('approve', _approvalId);
};

const handleDeny = () => {
  const msg = denyMessage.value.trim();
  hide();
  if (_onDeny) _onDeny(_approvalId, msg);
  emit('deny', _approvalId);
};

// 点击遮罩不关闭，强制用户做出选择
const handleOverlayClick = () => {};

defineExpose({ show, hide, toggleCollapsed });
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
  z-index: var(--z-dialog);
  padding: var(--spacing-md);
  animation: overlayFadeIn 0.2s ease;
}

@keyframes overlayFadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.approval-container {
  background: var(--color-bg-primary);
  border: 1.5px solid rgba(var(--color-warning-rgb), 0.6);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(var(--color-warning-rgb), 0.2);
  max-width: 520px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
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
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-md);
  background: linear-gradient(135deg, rgba(var(--color-warning-rgb), 0.1) 0%, transparent 100%);
  position: sticky;
  top: 0;
  z-index: 1;
}

.approval-header-main {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  min-width: 0;
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

.approval-title-wrap {
  min-width: 0;
}

.approval-subtitle {
  margin: 4px 0 0;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--color-text-secondary);
}

.approval-header-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid rgba(var(--color-warning-rgb), 0.28);
  border-radius: 999px;
  background: rgba(var(--color-warning-rgb), 0.12);
  color: var(--color-warning);
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 600;
  flex-shrink: 0;
  transition: background 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
}

.approval-header-action:hover {
  background: rgba(var(--color-warning-rgb), 0.18);
  border-color: rgba(var(--color-warning-rgb), 0.4);
}

.approval-header-action:active {
  transform: scale(0.98);
}

.approval-body {
  padding: var(--spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

/* 元信息行 */
.approval-meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-sm);
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--color-bg-secondary);
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  flex: 1;
  min-width: 0;
}

.meta-label {
  color: var(--color-text-secondary);
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}

.meta-value {
  color: var(--color-text-primary);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-value.mono {
  font-family: 'Courier New', monospace;
  font-size: 0.8125rem;
}

/* 风险标签 */
.risk-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}

.risk-badge.risk-high {
  background: rgba(var(--color-error-rgb), 0.15);
  color: var(--color-error);
  border: 1px solid rgba(var(--color-error-rgb), 0.3);
}

.risk-badge.risk-medium {
  background: rgba(var(--color-warning-rgb), 0.15);
  color: var(--color-warning);
  border: 1px solid rgba(var(--color-warning-rgb), 0.3);
}

.risk-badge.risk-low {
  background: rgba(var(--color-success-rgb), 0.15);
  color: var(--color-success);
  border: 1px solid rgba(var(--color-success-rgb), 0.3);
}

/* 操作说明 */
.approval-action-box {
  padding: var(--spacing-md);
  background: var(--color-bg-secondary);
  border-left: 2px solid rgba(var(--color-warning-rgb), 0.6);
  border-radius: var(--radius-sm);
}

.action-label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-text-secondary);
  margin-bottom: 4px;
  font-weight: 600;
}

.action-description {
  font-size: 0.9375rem;
  line-height: 1.6;
  color: var(--color-text-primary);
  font-weight: 500;
}

/* 额外审批信息 */
.approval-extra-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
}

.approval-extra-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.approval-extra-label {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  font-weight: 600;
  letter-spacing: 0.3px;
}

.approval-extra-value {
  font-size: 0.875rem;
  color: var(--color-text-primary);
  line-height: 1.6;
}

.approval-extra-item-stack {
  gap: 6px;
}

.approval-extra-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.approval-extra-list-item {
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  line-height: 1.5;
  word-break: break-all;
}

/* 调用参数 */
.approval-args-box {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.args-label {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  background: var(--color-bg-secondary);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--color-border);
}

.args-content {
  margin: 0;
  padding: 10px 12px;
  font-family: 'Courier New', monospace;
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--color-text-primary);
  background: transparent;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow-y: auto;
}

/* 警告 */
.approval-warning {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-sm);
  padding: 8px 12px;
  background: rgba(var(--color-warning-rgb), 0.08);
  border: 1px solid rgba(var(--color-warning-rgb), 0.25);
  border-radius: var(--radius-sm);
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--color-warning);
}

.approval-warning svg {
  flex-shrink: 0;
  margin-top: 2px;
}

/* 模式切换 Tab */
.approval-mode-tabs {
  display: flex;
  gap: 2px;
  background: var(--color-bg-secondary);
  padding: 3px;
  border-radius: var(--radius-sm);
}

.mode-tab {
  flex: 1;
  padding: 7px 12px;
  border: none;
  border-radius: calc(var(--radius-sm) - 2px);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  background: transparent;
  color: var(--color-text-secondary);
}

.mode-tab.active {
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
}

.mode-tab-deny.active {
  color: var(--color-error);
}

/* 附言输入 */
.approval-message-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.approval-message-box.denial .message-textarea {
  border-color: rgba(var(--color-error-rgb), 0.3);
}

.approval-message-box.denial .message-textarea:focus {
  border-color: rgba(var(--color-error-rgb), 0.6);
  box-shadow: 0 0 0 3px rgba(var(--color-error-rgb), 0.1);
}

.message-label {
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  font-weight: 500;
}

.message-textarea {
  width: 100%;
  padding: 8px 12px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
  font-size: 0.875rem;
  line-height: 1.5;
  resize: none;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s, box-shadow 0.2s;
  font-family: inherit;
}

.message-textarea:focus {
  border-color: var(--color-warning);
  box-shadow: 0 0 0 3px rgba(var(--color-warning-rgb), 0.15);
}

/* 底部按钮 */
.approval-footer {
  padding: var(--spacing-md) var(--spacing-lg) var(--spacing-lg);
  display: flex;
  gap: var(--spacing-sm);
  justify-content: flex-end;
}

.approval-btn {
  padding: 12px 28px;
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
  outline: none;
  width: 100%;
}

.approval-btn-approve {
  background: var(--color-warning);
  color: var(--color-bg-primary);
}

.approval-btn-approve:hover {
  background: var(--color-warning);
  box-shadow: 0 0 16px rgba(var(--color-warning-rgb), 0.5);
  transform: translateY(-1px);
}

.approval-btn-deny {
  background: rgba(var(--color-error-rgb), 0.12);
  color: var(--color-error);
  border: 1px solid rgba(var(--color-error-rgb), 0.35);
}

.approval-btn-deny:hover {
  background: rgba(var(--color-error-rgb), 0.2);
  box-shadow: 0 0 12px rgba(var(--color-error-rgb), 0.3);
  transform: translateY(-1px);
}

.approval-btn:active {
  transform: scale(0.98);
}

.approval-dock {
  position: fixed;
  right: 20px;
  top: 88px;
  width: 48px;
  height: 48px;
  padding: 0;
  border: 1px solid rgba(var(--color-warning-rgb), 0.3);
  border-radius: 999px;
  background: rgba(20, 20, 24, 0.92);
  backdrop-filter: blur(16px);
  color: var(--color-text-primary);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  z-index: var(--z-dialog);
  cursor: pointer;
}

.approval-dock-icon {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-warning);
}

.approval-dock-count {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--color-warning);
  color: var(--color-bg-primary);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 20px;
  text-align: center;
  box-shadow: 0 6px 16px rgba(var(--color-warning-rgb), 0.35);
}

.approval-dock-fade-enter-active,
.approval-dock-fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.approval-dock-fade-enter-from,
.approval-dock-fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
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
  .approval-header,
  .approval-body {
    padding: var(--spacing-md);
  }
  .approval-header {
    align-items: stretch;
    flex-direction: column;
  }
  .approval-header-main {
    width: 100%;
  }
  .approval-header-action {
    width: 100%;
    justify-content: center;
  }
  .approval-footer {
    padding: var(--spacing-sm) var(--spacing-md) var(--spacing-md);
  }
  .approval-meta-row {
    flex-direction: column;
  }
  .approval-dock {
    right: 12px;
    top: 76px;
    width: 44px;
    height: 44px;
  }
  .approval-dock-count {
    min-width: 18px;
    height: 18px;
    line-height: 18px;
    font-size: 0.6875rem;
  }
}
</style>
