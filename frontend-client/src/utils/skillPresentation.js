/**
 * Skill 库展示层纯函数：状态标签/徽标变体/来源文案/日期格式化。
 * variant 对应 components/ui/badge 的 variant。
 */

export function draftStatusLabel(draft) {
  if (draft.status === 'published' && draft.package_state === 'missing') return '发布包缺失';
  if (draft.status === 'published' && draft.package_state === 'conflict') return '发布冲突';
  return draft.status === 'published' ? '已发布' : '待发布';
}

export function draftStatusVariant(draft) {
  if (draft.status === 'published' && ['conflict', 'missing'].includes(draft.package_state)) return 'destructive';
  return draft.status === 'published' ? 'success' : 'warning';
}

export function draftOrigin(draft) {
  if (draft.source_agent_name) return `由 ${draft.source_agent_name} 创建`;
  if (draft.source_session_id) return `来自会话 ${draft.source_session_id}`;
  return '管理员 Draft';
}

export function sourceLabel(sourceType) {
  return { user_global: '租户', workspace: '工作区', builtin: '内置' }[sourceType] || '系统';
}

export function formatDraftDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatCompactDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}
