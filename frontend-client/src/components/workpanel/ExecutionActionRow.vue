<template>
  <div
    class="ear"
    :class="[
      `ear--${rowType}`,
      `status-${status}`,
      { 'ear--nested': depth > 0, 'ear--selected': isSelected, 'ear--has-children': hasChildren },
    ]"
    :data-node-key="nodeKeyValue"
  >
    <button
      type="button"
      class="ear-row"
      :aria-expanded="hasChildren ? expanded : undefined"
      @click="handleClick"
    >
      <!-- 状态借图标表达:运行中=转环,失败=红,完成=普通类型图标(无标记) -->
      <span
        class="ear-icon"
        :class="[`icon-${iconKind}`, { 'is-running': isRunning }]"
        :title="iconLabel"
        :aria-label="iconLabel"
        role="img"
      >
        <svg v-if="isRunning" class="ear-spinner" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="34 14" />
        </svg>
        <WorkPanelTimelineIcon v-else :kind="iconKind" />
      </span>

      <span class="ear-body">
        <span class="ear-title-row">
          <span class="ear-title">{{ titleText }}</span>
          <span v-if="agentBadge" class="ear-agent-badge" :style="agentBadgeStyle">{{ agentBadge }}</span>
        </span>
        <span v-if="subtitleText" class="ear-subtitle">{{ subtitleText }}</span>
      </span>

      <span class="ear-meta">
        <span v-if="statusLabel" class="ear-status-text" :class="{ 'is-error': status === 'error' }">{{ statusLabel }}</span>
        <span class="ear-time" :class="{ 'is-live': isRunning }">{{ elapsedText }}</span>
        <span v-if="hasChildren" class="ear-chevron" :class="{ expanded }" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="13" height="13">
            <path d="M7 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </span>
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import {
  formatExecutionElapsed as formatElapsed,
  getExecutionNodeKey as getNodeKey,
  normalizeExecutionStatus as normalizeStatus,
} from '../../utils/executionTreePresentation'
import {
  getToolDisplayName as resolveToolDisplayName,
  getToolIconKind as resolveToolIconKind,
  getToolSubtitle,
} from '../../utils/toolPresentation'
import WorkPanelTimelineIcon from './WorkPanelTimelineIcon.vue'

const props = defineProps({
  // 普通节点
  node: { type: Object, default: null },
  // 折叠组(与 node 二选一)
  group: { type: Object, default: null },
  depth: { type: Number, default: 0 },
  selectedKey: { type: String, default: '' },
  // agent_call 子树展开态 / group 展开态(由编排层持有下传)
  expanded: { type: Boolean, default: false },
})
const emit = defineEmits(['inspect', 'toggle'])

const isGroup = computed(() => Boolean(props.group))
const rowType = computed(() => {
  if (isGroup.value) return 'group'
  return props.node?.type || 'step'
})

const status = computed(() => {
  if (isGroup.value) return props.group.summary.status
  const own = normalizeStatus(props.node?.status)
  if (own === 'pending' && hasRunningChild(props.node)) return 'running'
  return own
})
const isRunning = computed(() => status.value === 'running')

// 状态文字:仅运行中显示(失败靠标题红+图标红表达,成功是默认态,均不加文字)。
const statusLabel = computed(() => (status.value === 'running' ? '执行中' : ''))

const nodeKeyValue = computed(() => {
  if (isGroup.value) return `group:${props.group.groupKey}:${firstNodeKey(props.group.nodes)}`
  return getNodeKey(props.node)
})
const isSelected = computed(() => !isGroup.value && props.selectedKey && props.selectedKey === nodeKeyValue.value)

const hasChildren = computed(() => {
  if (isGroup.value) return true
  return Array.isArray(props.node?.children) && props.node.children.length > 0
})

const iconKind = computed(() => {
  if (isGroup.value) return props.group.icon || 'tool'
  const node = props.node
  if (node.type === 'agent_call') return 'agent'
  if (node.type === 'agent_message') return 'input'
  if (node.type === 'injection') return 'input'
  if (node.type === 'tool_call') return resolveToolIconKind(node.tool_name)
  return 'step'
})

const iconLabel = computed(() => {
  if (isGroup.value) return '工具组'
  const node = props.node
  if (node.type === 'agent_call') return 'Agent'
  if (node.type === 'agent_message') return 'Agent 消息'
  if (node.type === 'injection') return node.injection_kind === 'background_notification' ? '后台通知' : '用户补充'
  return '工具'
})

const agentName = computed(() => {
  if (isGroup.value) return ''
  const node = props.node
  return node?.agent_display_name || node?.agent_name || node?.agent || ''
})
const agentBadge = computed(() => shortName(agentName.value))
const agentBadgeStyle = computed(() => agentColorStyle(agentName.value))

// 工具的动词短语(可能为空,空时主行退化为工具名)。
const toolSubtitle = computed(() => {
  if (isGroup.value || props.node?.type !== 'tool_call') return ''
  return getToolSubtitle(props.node, { running: isRunning.value })
})

const titleText = computed(() => {
  if (isGroup.value) {
    return `${props.group.summary.latestToolName ? groupNoun(props.group.icon) : '工具'} ×${props.group.summary.count}`
  }
  const node = props.node
  if (node.type === 'agent_call') {
    return truncate(node.description || node.result_summary || agentBadge.value || '调用智能体', 84)
  }
  if (node.type === 'tool_call') {
    // 行动为主:直接用工具产出的动词短语(读/写/搜/跑...),无则退回显示名。
    return toolSubtitle.value || resolveToolDisplayName(node)
  }
  if (node.type === 'injection') {
    return truncate(node.content || '注入消息', 84)
  }
  if (node.type === 'agent_message') {
    return truncate(node.content || `${node.message_kind || 'message'} 消息`, 84)
  }
  return '执行步骤'
})

const subtitleText = computed(() => {
  if (isGroup.value) return props.group.summary.latestPreview || ''
  const node = props.node
  if (node.type === 'agent_call') {
    if (node.result_summary && node.description) return truncate(node.result_summary, 72)
    return childProgressText(node)
  }
  if (node.type === 'tool_call') {
    // 主行已是动词短语时,副标题显示工具名补充;主行退化为工具名时副标题留空,避免重复。
    return toolSubtitle.value ? resolveToolDisplayName(node) : ''
  }
  if (node.type === 'agent_message') return node.message_kind || '消息'
  return ''
})

const elapsedText = computed(() => {
  if (isGroup.value) {
    const total = props.group.summary.totalElapsed
    return total > 0 ? formatElapsed(total) : ''
  }
  return formatElapsed(props.node?.elapsed_time)
})

function handleClick() {
  if (isGroup.value) {
    emit('toggle', props.group)
    return
  }
  emit('inspect', props.node)
  // 有子树的节点(agent_call):点击行同时切换展开,保持"点行=看详情+展开"的原交互。
  if (hasChildren.value) emit('toggle', props.node)
}

function groupNoun(icon) {
  const nouns = {
    search: '搜索', globe: '获取', file: '文件操作', code: '执行', database: '查询',
    map: '地图', chart: '可视化', skill: 'Skill', task: '任务', mcp: 'MCP 调用',
  }
  return nouns[icon] || '工具'
}

function childProgressText(node) {
  if (!Array.isArray(node.children) || !node.children.length) return ''
  let total = 0
  let done = 0
  let runningName = ''
  node.children.forEach(child => {
    if (child.type !== 'tool_call') return
    total += 1
    const s = normalizeStatus(child.status)
    if (s === 'success') done += 1
    if (s === 'running') runningName = resolveToolDisplayName(child)
  })
  if (!total) return ''
  const base = `${done}/${total} 工具`
  return runningName ? `${base} · 正在 ${runningName}` : base
}

function firstNodeKey(nodes) {
  return nodes && nodes.length ? getNodeKey(nodes[0]) : ''
}

function hasRunningChild(node) {
  if (!Array.isArray(node?.children)) return false
  return node.children.some(child => normalizeStatus(child.status) === 'running' || hasRunningChild(child))
}

function shortName(name) {
  if (!name) return ''
  return String(name).replace(/_agent$/i, '').replace(/_/g, ' ')
}

function truncate(value, max) {
  const text = String(value || '').trim()
  return text.length > max ? `${text.slice(0, max)}...` : text
}

const AGENT_PALETTE = ['violet', 'blue', 'green', 'cyan', 'orange', 'pink']
function agentColorStyle(name) {
  if (!name) return null
  let hash = 0
  const lower = String(name).trim().toLowerCase()
  for (let i = 0; i < lower.length; i += 1) {
    hash = ((hash << 5) - hash) + lower.charCodeAt(i)
    hash |= 0
  }
  const key = AGENT_PALETTE[Math.abs(hash) % AGENT_PALETTE.length]
  return {
    color: `var(--color-agent-${key})`,
    borderColor: `rgba(var(--color-agent-${key}-rgb), 0.26)`,
    background: `rgba(var(--color-agent-${key}-rgb), 0.1)`,
  }
}
</script>

<style scoped>
.ear {
  position: relative;
  letter-spacing: 0;
  content-visibility: auto;
  contain-intrinsic-size: auto 30px;
}

.ear-row {
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 4px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.ear-row:hover { background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.32); }

.ear--selected > .ear-row {
  background: rgba(var(--color-brand-accent-rgb), 0.085);
  box-shadow: inset 0 0 0 1px rgba(var(--color-brand-accent-rgb), 0.28);
}

.ear-icon {
  --type-color: var(--color-text-muted);
  --type-rgb: 142, 142, 147;
  width: 18px;
  height: 18px;
  color: var(--type-color);
  opacity: var(--icon-opacity, 1);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: color var(--transition-fast);
}

/* 失败:图标转 error 红,压过类型色(特异性须高于下方 .ear-icon.icon-*) */
.ear.status-error .ear-icon {
  --type-color: var(--color-error);
  --type-rgb: var(--color-error-rgb);
}

.ear-spinner {
  width: 14px;
  height: 14px;
  display: block;
  animation: ear-spin 0.9s linear infinite;
}

@keyframes ear-spin {
  to { transform: rotate(360deg); }
}

.ear-icon.icon-agent, .ear-icon.icon-skill { --type-color: var(--color-agent-violet); --type-rgb: var(--color-agent-violet-rgb); }

.ear-icon :deep(svg) {
  width: 14px;
  height: 14px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 转环尺寸覆盖(它有自己的 animation,不受上面 stroke 规则影响) */
.ear-icon .ear-spinner {
  stroke-width: 2;
}
.ear-icon.icon-thought, .ear-icon.icon-input { --type-color: var(--color-warning); --type-rgb: var(--color-warning-rgb); }
.ear-icon.icon-tool { --type-color: var(--color-agent-default); --type-rgb: var(--color-agent-default-rgb); }
.ear-icon.icon-code { --type-color: var(--color-brand-accent); --type-rgb: var(--color-brand-accent-rgb); }
.ear-icon.icon-file { --type-color: var(--color-success); --type-rgb: var(--color-success-rgb); }
.ear-icon.icon-search { --type-color: var(--color-agent-cyan); --type-rgb: var(--color-agent-cyan-rgb); }
.ear-icon.icon-globe { --type-color: var(--color-agent-blue); --type-rgb: var(--color-agent-blue-rgb); }
.ear-icon.icon-map, .ear-icon.icon-database { --type-color: var(--color-agent-green); --type-rgb: var(--color-agent-green-rgb); }
.ear-icon.icon-chart { --type-color: var(--color-agent-pink); --type-rgb: var(--color-agent-pink-rgb); }
.ear-icon.icon-task { --type-color: var(--color-agent-orange); --type-rgb: var(--color-agent-orange-rgb); }
.ear-icon.icon-agentCall { --type-color: var(--color-agent-violet); --type-rgb: var(--color-agent-violet-rgb); }
.ear-icon.icon-mcp { --type-color: var(--color-agent-blue); --type-rgb: var(--color-agent-blue-rgb); }

.ear-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ear-title-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.ear-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.35;
  color: var(--title-color, var(--color-text-primary));
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: var(--title-opacity, 1);
  transition: opacity var(--transition-fast);
}

/* 三态分级:运行中最醒目;已过去的成功沉下去;已过去的失败也沉但略高于成功,便于定位 */
.ear.status-success { --title-opacity: 0.5; --subtitle-opacity: 0.45; --title-weight: 500; --icon-opacity: 0.55; }
.ear.status-error { --title-opacity: 0.78; --subtitle-opacity: 0.6; --title-weight: 500; --icon-opacity: 1; --title-color: var(--color-error); }
.ear.status-running { --title-opacity: 1; --subtitle-opacity: 0.75; --title-weight: 600; --icon-opacity: 1; }
.ear.status-pending, .ear.status-stopped { --title-opacity: 0.55; --subtitle-opacity: 0.5; --title-weight: 500; --icon-opacity: 0.6; }

.ear-title {
  font-weight: var(--title-weight, 600);
}

.ear-subtitle {
  min-width: 0;
  font-size: 11px;
  line-height: 1.35;
  color: var(--color-text-secondary);
  opacity: var(--subtitle-opacity, 0.75);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: opacity var(--transition-fast);
}

.ear-agent-badge {
  display: inline-flex;
  align-items: center;
  max-width: min(112px, 38%);
  height: 17px;
  padding: 0 6px;
  border-radius: var(--radius-full);
  border: 1px solid transparent;
  font-size: 10px;
  line-height: 1;
  font-weight: 700;
  white-space: nowrap;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ear-meta {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-shrink: 0;
}

.ear-status-text {
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.ear-time {
  font-size: 10px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.ear-time.is-live { opacity: 1; }
.ear-row:hover .ear-time,
.ear--selected > .ear-row .ear-time { opacity: 1; }

.ear-chevron {
  display: inline-flex;
  width: 14px;
  justify-content: center;
  color: var(--color-text-muted);
  transition: transform var(--transition-fast), color var(--transition-fast);
}

.ear-chevron.expanded {
  transform: rotate(90deg);
  color: var(--color-text-secondary);
}

@media (prefers-reduced-motion: reduce) {
  .ear-spinner { animation: none; }
  .ear-row, .ear-icon, .ear-time, .ear-chevron { transition-duration: 1ms; }
}
</style>
