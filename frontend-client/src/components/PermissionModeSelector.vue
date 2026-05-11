<template>
  <div class="permission-selector" ref="selectorRef">
    <div
      class="permission-trigger"
      :class="{ open: dropdownOpen, danger: currentMode === 'dangerously_skip_permissions', skipAll: skipAllApprovals }"
      @click="toggleDropdown"
      :title="triggerTitle"
    >
      <svg v-if="currentModeMeta?.icon === 'strict'" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        class="mode-icon strict-icon">
        <rect x="5" y="11" width="14" height="10" rx="2"></rect>
        <path d="M8 11V8a4 4 0 0 1 8 0v3"></path>
      </svg>
      <svg v-else-if="currentModeMeta?.icon === 'standard'" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        class="mode-icon standard-icon">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
      </svg>
      <svg v-else-if="currentModeMeta?.icon === 'relaxed'" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        class="mode-icon relaxed-icon">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        <path d="m9 12 2 2 4-4"></path>
      </svg>
      <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        class="mode-icon danger-icon">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        <path d="M4 4l16 16"></path>
      </svg>
      <svg class="arrow-icon" :class="{ rotate: dropdownOpen }" xmlns="http://www.w3.org/2000/svg"
        width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </div>

    <transition name="dropdown">
      <div v-if="dropdownOpen" class="dropdown-panel">
        <div class="section-label">审批总开关</div>
        <div class="skip-all-row">
          <button
            type="button"
            class="skip-all-switch"
            :class="{ active: skipAllApprovals }"
            :aria-pressed="skipAllApprovals"
            @click="toggleSkipAllApprovals"
          >
            <span class="skip-all-switch-copy">
              <span class="skip-all-title-row">
                <span class="skip-all-toggle-title" :class="{ active: skipAllApprovals }">
                  {{ skipAllApprovalsMeta.label }}
                  <span class="skip-all-title-badge" :class="{ active: skipAllApprovals }">
                    {{ skipAllApprovals ? '已跳过' : '未跳过' }}
                  </span>
                </span>
                <button
                  type="button"
                  class="skip-all-expand-btn"
                  :aria-expanded="skipAllDetailsOpen"
                  title="查看说明"
                  @click.stop="skipAllDetailsOpen = !skipAllDetailsOpen"
                >
                  i
                </button>
              </span>
            </span>
            <span class="skip-all-switch-track" aria-hidden="true">
              <span class="skip-all-switch-thumb"></span>
            </span>
          </button>
        </div>
        <p v-if="skipAllDetailsOpen" class="skip-all-desc">{{ skipAllApprovalsMeta.desc }}</p>

        <div class="section-divider"></div>

        <!-- 模式选择 -->
        <div class="section-label">权限模式</div>
        <div class="mode-options" :class="{ disabled: skipAllApprovals }">
          <div
            v-for="m in modes"
            :key="m.value"
            class="mode-option"
            :class="{ selected: currentMode === m.value, danger: m.value === 'dangerously_skip_permissions', disabled: skipAllApprovals }"
            @click="selectMode(m.value)"
          >
            <div class="mode-option-main">
              <span class="mode-name">{{ m.label }}</span>
              <svg v-if="currentMode === m.value" class="check-icon" xmlns="http://www.w3.org/2000/svg"
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </div>
            <span class="mode-desc">{{ m.desc }}</span>
          </div>
        </div>

        <!-- 自动接受规则 -->
        <div class="section-divider"></div>
        <div class="section-label">
          自动接受规则
          <button class="add-rule-btn" @click.stop="showAddRule = !showAddRule" title="添加规则">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
        </div>

        <!-- 添加规则表单 -->
        <div v-if="showAddRule" class="add-rule-form" @click.stop>
          <select v-model="newRule.type" class="rule-select">
            <option value="tool_name">工具名</option>
            <option value="file_pattern">文件路径</option>
            <option value="risk_level">风险等级</option>
          </select>
          <input
            v-model="newRule.value"
            class="rule-input"
            :placeholder="rulePlaceholder"
            @keydown.enter="addRule"
          />
          <button class="rule-confirm-btn" @click="addRule" :disabled="!newRule.value.trim()">添加</button>
        </div>

        <!-- 已有规则列表 -->
        <div v-if="patterns.length" class="rules-list">
          <div v-for="(p, i) in patterns" :key="i" class="rule-item">
            <span class="rule-type-badge">{{ ruleTypeLabel(p.pattern_type) }}</span>
            <span class="rule-value">{{ p.pattern_value }}</span>
            <button class="rule-delete-btn" @click.stop="removeRule(p)" title="删除">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        <div v-else class="rules-empty">暂无规则</div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { usePointerDownOutside } from '../composables/usePointerDownOutside';
import {
  getPermissionPolicy,
  updatePermissionMode,
  updatePermissionPolicy,
  addAutoAcceptPattern,
  removeAutoAcceptPattern,
} from '../api/permissions';
import { PERMISSION_MODE_OPTIONS, SKIP_ALL_APPROVALS_META, getPermissionModeLabel } from '../utils/permissionPresentation';

const selectorRef = ref(null);
const dropdownOpen = ref(false);
const currentMode = ref('standard');
const patterns = ref([]);
const skipAllApprovals = ref(false);
const skipAllDetailsOpen = ref(false);
const showAddRule = ref(false);
const newRule = ref({ type: 'tool_name', value: '' });

const modes = PERMISSION_MODE_OPTIONS;
const skipAllApprovalsMeta = SKIP_ALL_APPROVALS_META;

const currentModeMeta = computed(() => modes.find(m => m.value === currentMode.value) || null);

const modeLabel = computed(() => getPermissionModeLabel(currentMode.value));
const triggerTitle = computed(() => {
  if (skipAllApprovals.value) {
    return '权限模式: 跳过所有审批（已开启，总开关生效）';
  }
  return `权限模式: ${modeLabel.value}`;
});

const rulePlaceholder = computed(() => {
  const map = { tool_name: 'write_file 或 read_*', file_pattern: '*.md 或 src/**/*.py', risk_level: 'low / medium / high' };
  return map[newRule.value.type] || '';
});

function ruleTypeLabel(type) {
  const map = { tool_name: '工具', file_pattern: '路径', risk_level: '等级' };
  return map[type] || type;
}

function toggleDropdown() {
  dropdownOpen.value = !dropdownOpen.value;
}

usePointerDownOutside({
  inside: [selectorRef],
  enabled: () => dropdownOpen.value,
  onOutside: () => {
    dropdownOpen.value = false;
  },
});

async function loadPolicy() {
  try {
    const policy = await getPermissionPolicy();
    currentMode.value = policy.mode;
    patterns.value = policy.auto_accept_patterns || [];
    skipAllApprovals.value = Boolean(policy.skip_all_approvals);
  } catch { /* ignore */ }
}

async function selectMode(mode) {
  if (skipAllApprovals.value) return;
  try {
    await updatePermissionMode(mode);
    currentMode.value = mode;
  } catch { /* ignore */ }
}

async function toggleSkipAllApprovals() {
  try {
    const policy = await updatePermissionPolicy({
      mode: currentMode.value,
      auto_accept_patterns: patterns.value,
      skip_all_approvals: !skipAllApprovals.value,
    });
    skipAllApprovals.value = Boolean(policy.skip_all_approvals);
    currentMode.value = policy.mode;
    patterns.value = policy.auto_accept_patterns || [];
  } catch { /* ignore */ }
}

async function addRule() {
  const val = newRule.value.value.trim();
  if (!val) return;
  try {
    const policy = await addAutoAcceptPattern(newRule.value.type, val);
    patterns.value = policy.auto_accept_patterns || [];
    newRule.value.value = '';
    showAddRule.value = false;
  } catch { /* ignore */ }
}

async function removeRule(p) {
  try {
    const policy = await removeAutoAcceptPattern(p.pattern_type, p.pattern_value);
    patterns.value = policy.auto_accept_patterns || [];
  } catch { /* ignore */ }
}

onMounted(() => {
  loadPolicy();
});
</script>

<style scoped>
.permission-selector {
  position: relative;
}

.permission-trigger {
  width: var(--icon-button-size-md);
  height: var(--control-height-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 50%;
  background: var(--color-interactive);
  cursor: pointer;
  color: var(--color-text-primary);
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  user-select: none;
}

.permission-trigger:hover {
  background: var(--color-interactive-hover);
  box-shadow: var(--shadow-glow);
  transform: scale(1.1);
}

.permission-trigger:active {
  transform: scale(0.95);
}

.permission-trigger.open {
  background: var(--color-interactive-hover);
  box-shadow: var(--shadow-glow);
}

.permission-trigger.danger {
  color: var(--color-error);
}

.permission-trigger.danger .mode-icon {
  color: var(--color-error);
}

.permission-trigger.skipAll {
  color: var(--color-error);
  border-color: rgba(var(--color-error-rgb, 239, 68, 68), 0.42);
  background: rgba(var(--color-error-rgb, 239, 68, 68), 0.1);
  box-shadow: 0 0 0 3px rgba(var(--color-error-rgb, 239, 68, 68), 0.12);
}

.permission-trigger.skipAll:hover,
.permission-trigger.skipAll.open {
  background: rgba(var(--color-error-rgb, 239, 68, 68), 0.16);
  box-shadow: 0 0 0 3px rgba(var(--color-error-rgb, 239, 68, 68), 0.18);
}

.permission-trigger.skipAll .mode-icon {
  color: var(--color-error);
}

.mode-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.mode-text {
  display: none;
}

.arrow-icon {
  display: none;
}

.arrow-icon.rotate {
  transform: rotate(180deg);
}

/* 下拉面板 */
.dropdown-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 280px;
  max-width: 340px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 12px);
  box-shadow: var(--shadow-xl);
  z-index: var(--z-dropdown, 100);
  padding: 8px 0;
}

.section-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px 4px;
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-text-secondary);
}

.section-divider {
  height: 1px;
  background: var(--color-border);
  margin: 6px 12px;
}

.skip-all-row {
  padding: 6px 12px 4px;
}

.skip-all-switch {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.skip-all-switch:hover {
  background: var(--color-bg-tertiary, var(--color-bg-secondary));
}

.skip-all-switch.active {
  border-color: rgba(var(--color-error-rgb, 239, 68, 68), 0.38);
  background: rgba(var(--color-error-rgb, 239, 68, 68), 0.08);
}

.skip-all-switch-copy {
  min-width: 0;
  display: flex;
  align-items: center;
}

.skip-all-title-row {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.skip-all-toggle-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8125rem;
  font-weight: 500;
}

.skip-all-toggle-title.active {
  color: var(--color-error);
}

.skip-all-title-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(var(--color-text-secondary-rgb, 148, 163, 184), 0.12);
  color: var(--color-text-secondary);
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.4;
}

.skip-all-title-badge.active {
  background: rgba(var(--color-error-rgb, 239, 68, 68), 0.14);
  color: var(--color-error);
}

.skip-all-toggle-state {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}

.skip-all-switch.active .skip-all-toggle-title {
  color: var(--color-error);
}

.skip-all-switch-track {
  position: relative;
  width: 34px;
  height: 20px;
  flex-shrink: 0;
  border-radius: 999px;
  background: rgba(var(--color-text-secondary-rgb, 148, 163, 184), 0.35);
  transition: background 0.15s;
}

.skip-all-switch.active .skip-all-switch-track {
  background: rgba(var(--color-error-rgb, 239, 68, 68), 0.45);
}

.skip-all-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--color-bg-elevated);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16);
  transition: transform 0.15s ease;
}

.skip-all-switch.active .skip-all-switch-thumb {
  transform: translateX(14px);
}

.skip-all-expand-btn {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 0.75rem;
  font-style: italic;
  font-weight: 600;
  line-height: 1;
  padding: 0;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}

.skip-all-expand-btn:hover {
  color: var(--color-text-primary);
  border-color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
}

.skip-all-desc {
  margin: 4px 12px 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-text-secondary);
}

.mode-options.disabled {
  opacity: 0.45;
  pointer-events: none;
}

/* 模式选项 */
.mode-option {
  padding: 8px 14px;
  cursor: pointer;
  transition: background 0.15s;
}

.mode-option:hover {
  background: var(--color-bg-secondary);
}

.mode-option.selected {
  background: rgba(var(--color-brand-accent-rgb), 0.08);
}

.mode-option.danger {
  border-left: 2px solid var(--color-error);
}

.mode-option.danger .mode-name {
  color: var(--color-error);
}

.mode-option.disabled {
  cursor: not-allowed;
}

.mode-option-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mode-name {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-text-primary);
}

.mode-desc {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  margin-top: 2px;
  display: block;
}

.check-icon {
  color: var(--color-brand-accent);
  flex-shrink: 0;
}

/* 添加规则 */
.add-rule-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-secondary);
  padding: 2px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  transition: color 0.15s;
}

.add-rule-btn:hover {
  color: var(--color-text-primary);
}

.add-rule-form {
  display: flex;
  gap: 4px;
  padding: 6px 12px;
  align-items: center;
}

.rule-select {
  padding: 4px 6px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-size: 0.75rem;
  outline: none;
  flex-shrink: 0;
}

.rule-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-size: 0.75rem;
  outline: none;
}

.rule-input:focus {
  border-color: var(--color-brand-accent);
}

.rule-confirm-btn {
  padding: 4px 10px;
  border: none;
  border-radius: 6px;
  background: var(--color-brand-accent);
  color: var(--color-on-color);
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.15s;
}

.rule-confirm-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 规则列表 */
.rules-list {
  padding: 4px 12px 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rule-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--color-bg-secondary);
  border-radius: 6px;
  font-size: 0.75rem;
}

.rule-type-badge {
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(var(--color-brand-accent-rgb), 0.12);
  color: var(--color-brand-accent);
  font-size: 0.6875rem;
  font-weight: 600;
  flex-shrink: 0;
}

.rule-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-primary);
  font-family: 'Courier New', monospace;
}

.rule-delete-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-secondary);
  padding: 2px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  transition: color 0.15s;
}

.rule-delete-btn:hover {
  color: var(--color-error);
}

.rules-empty {
  padding: 8px 14px;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  text-align: center;
}

/* 动画 */
.dropdown-enter-active,
.dropdown-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* 移动端 */
@media (max-width: 767px) {
  .mode-text {
    display: none;
  }
  .arrow-icon {
    display: none;
  }
  .permission-trigger {
    padding: 8px;
    width: var(--icon-button-size-md);
    height: var(--control-height-md);
    justify-content: center;
  }
  .dropdown-panel {
    min-width: 260px;
    right: -8px;
  }
}
</style>
