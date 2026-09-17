export function sourceLabel(sourceType) {
  return { user_global: '租户', workspace: '工作区', builtin: '内置' }[sourceType] || '系统';
}
