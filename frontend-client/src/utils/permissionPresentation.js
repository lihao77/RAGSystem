export const PERMISSION_MODE_OPTIONS = [
  { value: 'strict', label: '严格', desc: '全部风险工具需审批；命中规则时可自动通过', icon: 'strict' },
  { value: 'standard', label: '默认', desc: '中/高风险工具需审批；命中规则时可自动通过', icon: 'standard' },
  { value: 'relaxed', label: '高风险', desc: '仅高风险工具需审批；命中规则时可自动通过', icon: 'relaxed' },
  { value: 'dangerously_skip_permissions', label: '跳过审批', desc: '跳过常规风险审批；路径越界等 ask 仍可能触发', icon: 'danger' },
];

export const AUTO_ACCEPT_PATTERN_OPTIONS = [
  { value: 'tool_name', label: '工具名' },
  { value: 'file_pattern', label: '文件路径' },
  { value: 'risk_level', label: '风险等级' },
];

export const SKIP_ALL_APPROVALS_META = {
  label: '跳过所有审批',
  desc: '关闭所有 ask 流程，包括路径越界、hook 强制 ask 和内联审批；仍保留工具执行权限 deny。',
};

const KNOWN_PERMISSION_MODES = new Set(PERMISSION_MODE_OPTIONS.map((item) => item.value));

export function getPermissionModeMeta(mode) {
  return PERMISSION_MODE_OPTIONS.find((item) => item.value === mode) || null;
}

export function getPermissionModeLabel(mode) {
  return getPermissionModeMeta(mode)?.label || mode || '';
}

export function createEmptyAutoAcceptPattern() {
  return { pattern_type: 'tool_name', pattern_value: '', description: '' };
}

export function sanitizeAutoAcceptPatterns(patterns = []) {
  if (!Array.isArray(patterns)) return [];
  return patterns
    .map((pattern) => ({
      pattern_type: pattern?.pattern_type || 'tool_name',
      pattern_value: String(pattern?.pattern_value || '').trim(),
      description: String(pattern?.description || '').trim(),
    }))
    .filter((pattern) => pattern.pattern_value);
}

export function normalizePermissionPolicy(policy = {}) {
  const timeout = Number(policy?.approval_timeout);
  return {
    mode: KNOWN_PERMISSION_MODES.has(policy?.mode) ? policy.mode : 'standard',
    auto_accept_patterns: sanitizeAutoAcceptPatterns(policy?.auto_accept_patterns),
    audit_all_checks: Boolean(policy?.audit_all_checks),
    approval_timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 300,
    skip_all_approvals: Boolean(policy?.skip_all_approvals),
  };
}

export function serializePermissionPolicy(policy = {}) {
  const normalized = normalizePermissionPolicy(policy);
  return {
    mode: normalized.mode,
    auto_accept_patterns: normalized.auto_accept_patterns,
    audit_all_checks: normalized.audit_all_checks,
    approval_timeout: normalized.approval_timeout,
    skip_all_approvals: normalized.skip_all_approvals,
  };
}

export function getApprovalReasonText(reason) {
  return reason || '';
}

export function getApprovalReasonLabels(reasonCodes = []) {
  const labels = [];
  for (const code of reasonCodes || []) {
    if (code === 'ask-risk') labels.push('风险审批');
    if (code === 'ask-path') labels.push('路径越界审批');
  }
  return labels;
}
