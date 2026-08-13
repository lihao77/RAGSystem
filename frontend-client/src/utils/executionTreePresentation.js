import { getToolIconKind, getToolSubtitle } from './toolPresentation.js'

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

/** 连续同类工具折叠阈值:达到该数量才收成组,1–2 个平铺。 */
export const TOOL_GROUP_MIN = 3

/**
 * 工具分组键:同类工具(iconKind)同键,作为"连续同类"的判定依据。
 * 只对 tool_call 分组,其余类型返回 null 不参与分组。
 */
export function getToolGroupKey(node) {
  if (!node || node.type !== 'tool_call') return null
  // 交互型工具(等待用户输入)必须始终独立成行,绝不折叠。
  if (node.tool_name === 'request_user_input' || node.tool_name === 'agent') return null
  return getToolIconKind(node.tool_name)
}

/**
 * 把一层 children 转成"渲染行"数组:连续相同 groupKey 的 tool_call ≥ TOOL_GROUP_MIN
 * 合成一个 group 行,其余节点逐个平铺。group 携带展示所需的聚合摘要。
 * 纯函数,只读 node 不修改;分组是展示层概念,不触碰 core 投影。
 *
 * @param {Array} nodes - 某一层(某父节点的 children)节点
 * @returns {Array<{kind:'node',node}|{kind:'group',groupKey,icon,nodes,summary}>}
 */
export function buildActionRows(nodes = []) {
  const rows = []
  let buffer = []
  let bufferKey = null

  const flushBuffer = () => {
    if (buffer.length >= TOOL_GROUP_MIN) {
      rows.push(makeGroupRow(bufferKey, buffer))
    } else {
      buffer.forEach(node => rows.push({ kind: 'node', node }))
    }
    buffer = []
    bufferKey = null
  }

  nodes.forEach(node => {
    const key = getToolGroupKey(node)
    if (key && key === bufferKey) {
      buffer.push(node)
      return
    }
    flushBuffer()
    if (key) {
      bufferKey = key
      buffer = [node]
    } else {
      rows.push({ kind: 'node', node })
    }
  })
  flushBuffer()
  return rows
}

function makeGroupRow(groupKey, nodes) {
  const latest = nodes[nodes.length - 1] || null
  let totalElapsed = 0
  let hasRunning = false
  let hasError = false
  let successCount = 0
  nodes.forEach(node => {
    const status = normalizeExecutionStatus(node.status)
    if (status === 'running') hasRunning = true
    if (status === 'error') hasError = true
    if (status === 'success') successCount += 1
    const elapsed = Number(node.elapsed_time)
    if (Number.isFinite(elapsed)) totalElapsed += elapsed
  })
  return {
    kind: 'group',
    groupKey,
    icon: groupKey,
    nodes,
    summary: {
      count: nodes.length,
      successCount,
      hasRunning,
      hasError,
      totalElapsed,
      status: hasError ? 'error' : (hasRunning ? 'running' : 'success'),
      latestPreview: latest ? getToolSubtitle(latest, { running: normalizeExecutionStatus(latest.status) === 'running' }) : '',
      latestToolName: latest ? getToolIconKind(latest.tool_name) : groupKey,
    },
  }
}
