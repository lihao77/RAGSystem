export function normalizeExecutionStatus(status) {
  if (status === 'succeeded' || status === 'completed' || status === 'success') return 'success'
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'cancelled' || status === 'interrupted' || status === 'stopped') return 'stopped'
  if (status === 'running') return 'running'
  return 'pending'
}

export function getExecutionNodeKey(node) {
  if (!node) return ''
  if (node.call_id) return `call:${node.call_id}`
  if (node.task_id) return `task:${node.task_id}`
  if (node.message_id) return `message:${node.message_id}`
  const identity = node.tool_name || node.agent_name || node.agent || node.agent_display_name || node.intent || node.description || ''
  return `${node.type || 'node'}:${node.round || ''}:${String(identity).slice(0, 80)}`
}

export function flattenExecutionNodes(items = []) {
  const result = []
  const walk = (children) => {
    children.forEach((child) => {
      result.push(child)
      if (Array.isArray(child.children) && child.children.length > 0) walk(child.children)
    })
  }
  walk(items)
  return result
}

export function formatExecutionElapsed(value) {
  if (value === null || value === undefined || value === '') return ''
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))}ms`
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m${rest}s`
}
