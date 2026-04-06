export const PERMISSION_MODE_OPTIONS = [
  { value: 'strict', label: '严格', desc: '全部风险工具需审批；命中规则时可自动通过', icon: 'strict' },
  { value: 'standard', label: '默认', desc: '中/高风险工具需审批；命中规则时可自动通过', icon: 'standard' },
  { value: 'relaxed', label: '高风险', desc: '仅高风险工具需审批；命中规则时可自动通过', icon: 'relaxed' },
  { value: 'dangerously_skip_permissions', label: '跳过审批', desc: '跳过常规风险审批；路径越界等 ask 仍可能触发', icon: 'danger' },
];

export const SKIP_ALL_APPROVALS_META = {
  label: '跳过所有审批',
  desc: '关闭所有 ask 流程，包括路径越界、hook 强制 ask 和内联审批；仍保留工具执行权限 deny。',
};

export function getPermissionModeMeta(mode) {
  return PERMISSION_MODE_OPTIONS.find((item) => item.value === mode) || null;
}

export function getPermissionModeLabel(mode) {
  return getPermissionModeMeta(mode)?.label || mode || '';
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
