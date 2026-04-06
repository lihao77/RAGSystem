export const PERMISSION_MODE_OPTIONS = [
  { value: 'strict', label: '严格', desc: '全部风险工具需审批；命中规则时可自动通过', icon: 'strict' },
  { value: 'standard', label: '默认', desc: '中/高风险工具需审批；命中规则时可自动通过', icon: 'standard' },
  { value: 'relaxed', label: '高风险', desc: '仅高风险工具需审批；命中规则时可自动通过', icon: 'relaxed' },
  { value: 'dangerously_skip_permissions', label: '跳过审批', desc: '跳过审批，不再弹出确认', icon: 'danger' },
];

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
