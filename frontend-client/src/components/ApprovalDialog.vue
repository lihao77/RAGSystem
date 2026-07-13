<template>
  <Dialog :open="visible && !collapsed" @update:open="(v) => { if (!v) collapsed = true }">
    <DialogContent class="approval-shell max-w-[560px] gap-0 p-0" hide-close @pointer-down-outside.prevent @escape-key-down.prevent="onEscapeKeyDown">
      <div class="approval-header">
            <div class="approval-header-main">
              <div class="approval-icon">
                <IconWarning :size="24" />
              </div>
              <div class="approval-title-wrap">
                <DialogTitle class="approval-title">权限确认</DialogTitle>
                <DialogDescription class="sr-only">{{ agentName }} 请求执行 {{ toolName }}：{{ actionDescription }}</DialogDescription>
                <p class="approval-subtitle">可先折叠窗口，继续查看 AI 实时进展</p>
              </div>
            </div>
            <Button class="approval-header-action" variant="ghost" size="sm" @click="toggleCollapsed" title="折叠审批窗口">
              <IconChevronDown :size="16" />
              <span>折叠</span>
            </Button>
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
              <div v-if="hasExternalPathCandidates" class="approval-extra-item approval-extra-item-stack">
                <span class="approval-extra-label">待审批路径</span>
                <div class="approval-extra-list">
                  <div v-for="path in externalPathCandidates" :key="path" class="approval-extra-list-item mono">{{ path }}</div>
                </div>
              </div>
            </div>

            <!-- 调用参数 -->
            <div v-if="hasArguments" class="approval-args-box">
              <div class="args-label">
                <IconDocument :size="13" />
                调用参数
              </div>
              <pre class="args-content">{{ formattedArguments }}</pre>
            </div>

            <!-- 警告提示 -->
            <div class="approval-warning">
              <IconInfo :size="14" />
              <span>此操作可能修改数据或执行敏感命令，请谨慎确认</span>
            </div>

            <!-- 审批模式切换 -->
            <div class="approval-mode-tabs" role="tablist" aria-label="审批决定">
              <button
                role="tab"
                id="approval-tab-approve"
                class="mode-tab"
                :class="{ active: activeMode === 'approve' }"
                :aria-selected="activeMode === 'approve'"
                :tabindex="activeMode === 'approve' ? 0 : -1"
                @click="setMode('approve')"
                @keydown="onTabKeydown"
              ><IconCheck :size="14" class="mode-tab-icon" />允许执行</button>
              <button
                role="tab"
                id="approval-tab-deny"
                class="mode-tab mode-tab-deny"
                :class="{ active: activeMode === 'deny' }"
                :aria-selected="activeMode === 'deny'"
                :tabindex="activeMode === 'deny' ? 0 : -1"
                @click="setMode('deny')"
                @keydown="onTabKeydown"
              ><IconClose :size="14" class="mode-tab-icon" />拒绝</button>
            </div>

            <!-- 附言（同意/拒绝共用同一个输入框） -->
            <div class="approval-message-box" :class="{ denial: activeMode === 'deny' }">
              <label class="message-label">{{ messageLabel }}</label>
              <textarea
                v-model="message"
                class="message-textarea"
                :placeholder="messagePlaceholder"
                rows="2"
              ></textarea>
            </div>
          </div>

          <DialogFooter class="approval-footer">
            <Button
              v-if="activeMode === 'approve'"
              class="approval-btn w-full"
              variant="default"
              @click="handleApprove"
            ><IconCheck :size="16" /> 确认允许执行</Button>
            <Button
              v-if="activeMode === 'deny'"
              class="approval-btn w-full"
              variant="destructive"
              @click="handleDeny"
            ><IconClose :size="16" /> 确认拒绝</Button>
          </DialogFooter>
    </DialogContent>
  </Dialog>

  <Teleport to="body">
    <Transition name="approval-dock-fade">
      <button
        v-if="visible && collapsed"
        class="approval-dock"
        type="button"
        :title="`待审批 ${queueCount} 条，点击展开`"
        @click="toggleCollapsed"
      >
        <div class="approval-dock-icon">
          <IconWarning :size="16" />
        </div>
        <span class="approval-dock-count">{{ queueCount }}</span>
      </button>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue';
import { getApprovalReasonLabels, getApprovalReasonText, getPermissionModeLabel } from '../utils/permissionPresentation';
import IconWarning from './icons/IconWarning.vue';
import IconInfo from './icons/IconInfo.vue';
import IconChevronDown from './icons/IconChevronDown.vue';
import IconDocument from './icons/IconDocument.vue';
import IconCheck from './icons/IconCheck.vue';
import IconClose from './icons/IconClose.vue';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';

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
const externalPathCandidates = ref([]);
const queueCount = ref(1);
const activeMode = ref('approve');
const message = ref('');
const messageLabel = computed(() => activeMode.value === 'deny' ? '拒绝理由 / 后续指令（可选）' : '附加提示（可选）');
const messagePlaceholder = computed(() => activeMode.value === 'deny'
  ? '可告诉智能体原因或指定下一步，例如：请改用只读方式查询…'
  : '可向智能体补充说明，例如：请特别注意备份现有数据…');

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
const hasExternalPathCandidates = computed(() => externalPathCandidates.value.length > 0);

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
 * @param {object} data - { approval_id, tool_name, arguments, risk_level, description, agent_name, permission_mode, approval_reason, approval_reason_codes, approval_secondary_reasons, external_path_candidates }
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
  externalPathCandidates.value = Array.isArray(data.external_path_candidates) ? data.external_path_candidates : [];
  queueCount.value = Number.isFinite(data.queue_count) && data.queue_count > 0 ? data.queue_count : 1;
  activeMode.value = 'approve';
  message.value = '';
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

// ESC 不直接关闭弹窗（防误触批准/拒绝），改为折叠到 dock 保留 pending
const onEscapeKeyDown = () => {
  if (!collapsed.value) toggleCollapsed();
};

const setMode = (mode) => { activeMode.value = mode; };

// ARIA tab 模式：左右方向键在 允许/拒绝 间切换并移动焦点
const onTabKeydown = (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  e.preventDefault();
  activeMode.value = activeMode.value === 'approve' ? 'deny' : 'approve';
  nextTick(() => {
    const id = activeMode.value === 'approve' ? 'approval-tab-approve' : 'approval-tab-deny';
    document.getElementById(id)?.focus();
  });
};

const handleApprove = () => {
  const msg = message.value.trim();
  hide();
  if (_onApprove) _onApprove(_approvalId, msg);
  emit('approve', _approvalId);
};

const handleDeny = () => {
  const msg = message.value.trim();
  hide();
  if (_onDeny) _onDeny(_approvalId, msg);
  emit('deny', _approvalId);
};

defineExpose({ show, hide, toggleCollapsed });
</script>

<style scoped>
/* 玻璃浮层外壳 —— 与 ImageLightbox 浮层基线一致：半透 + blur + border + 大圆角 + 深阴影 */
.approval-shell {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border: 1px solid var(--color-glass-border);
  border-radius: var(--radius-xl);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16), 0 24px 80px rgba(0, 0, 0, 0.5);
}

.approval-header {
  padding: var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-md);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
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
  box-shadow: 0 0 0 4px rgba(var(--color-warning-rgb), 0.16), 0 6px 16px rgba(var(--color-warning-rgb), 0.3);
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
  border: 1px solid var(--color-glass-border);
  border-radius: 999px;
  background: var(--color-hover-overlay);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: var(--color-warning);
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 600;
  flex-shrink: 0;
  transition: background 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
}

.approval-header-action:hover {
  background: var(--color-hover-overlay-md);
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
  font-family: var(--font-mono);
  font-size: 0.8125rem;
}

/* 风险标签 */
.risk-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px 2px 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}
.risk-badge::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  margin-right: 5px;
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
  font-family: var(--font-mono);
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
  background: var(--color-hover-overlay);
  border: 1px solid var(--color-glass-border);
  padding: 3px;
  border-radius: var(--radius-md);
}

.mode-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 12px;
  border: none;
  border-radius: calc(var(--radius-sm) - 2px);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
  background: transparent;
  color: var(--color-text-secondary);
}
.mode-tab-icon { flex-shrink: 0; }

.mode-tab.active {
  background: var(--color-accent-bg);
  color: var(--color-accent);
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
}

.mode-tab-deny.active {
  background: var(--color-error-bg);
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
  border-radius: var(--radius-md);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid transparent;
  outline: none;
  width: 100%;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2);
}

.approval-btn:active:not(:disabled) {
  transform: scale(0.97);
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
  background: var(--glass-bg);
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

/* 移动端适配 */
@media (max-width: 767px) {
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
