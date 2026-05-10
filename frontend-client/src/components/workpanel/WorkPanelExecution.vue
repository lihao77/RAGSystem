<template>
  <div class="wpe-root">
    <div class="wpe-header">
      <div class="wpe-heading">
        <span class="wpe-title">执行过程</span>
        <span class="wpe-summary">{{ summaryText }}</span>
      </div>
      <div class="wpe-meta">
        <button
          v-if="stats.running > 0"
          type="button"
          class="wpe-chip chip-running"
          title="定位运行中步骤"
          @click="focusRunningNode"
        >
          <span class="wpe-running-dot"></span>
          {{ stats.running }}
        </button>
        <button
          v-if="stats.error > 0"
          type="button"
          class="wpe-chip chip-error"
          title="定位失败步骤"
          @click="focusErrorNode"
        >{{ stats.error }} 失败</button>
        <span v-else-if="stats.success > 0" class="wpe-chip chip-success">{{ stats.success }} 完成</span>
      </div>
    </div>
    <Transition name="wpe-focus">
      <button
        v-if="focusNode"
        type="button"
        class="wpe-focus-strip"
        :class="`status-${normalizeStatus(focusNode.status)}`"
        title="定位当前关注步骤"
        @click="focusNodeInList(focusNode)"
      >
        <span class="wpe-focus-dot" aria-hidden="true"></span>
        <span class="wpe-focus-label">{{ focusStripLabel }}</span>
        <span class="wpe-focus-title">{{ focusStripTitle }}</span>
      </button>
    </Transition>

    <Transition name="wpe-list-state" mode="out-in">
      <div v-if="nodes.length === 0" key="empty" class="wpe-empty">
        <span class="wpe-empty-mark" aria-hidden="true"></span>
        <span>{{ running ? '等待第一步执行' : '暂无执行过程' }}</span>
      </div>
      <div v-else key="list" class="wpe-list" ref="listRef">
        <TransitionGroup name="wpe-node" tag="div" class="wpe-node-stack">
          <ExecutionTimelineNode
            v-for="(node, i) in nodes"
            :key="nodeKey(node, i)"
            :node="node"
            :depth="0"
            :session-id="sessionId"
            :focus-key="focusKey"
            :selected-key="selectedKey"
            @inspect="selectNode"
          />
        </TransitionGroup>
      </div>
    </Transition>

    <Transition name="wpe-inspector">
      <div v-if="selectedNode" class="wpe-inspector">
      <div class="wpe-inspector-header">
        <div class="wpe-inspector-title">
          <span class="wpe-inspector-kicker">{{ inspectorTypeLabel }}</span>
          <span class="wpe-inspector-name">{{ inspectorTitle }}</span>
        </div>
        <button type="button" class="wpe-inspector-close" title="关闭详情" @click="selectedNode = null">
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div class="wpe-inspector-body">
        <section v-if="selectedInspectorMeta.length || selectedSummarySections.length || selectedNode.ctx?.max > 0" class="wpe-inspector-section">
          <div class="wpe-section-heading">摘要</div>
          <div v-if="selectedInspectorMeta.length" class="wpe-meta-grid">
            <div v-for="item in selectedInspectorMeta" :key="item.label" class="wpe-meta-item">
              <span class="wpe-meta-label">{{ item.label }}</span>
              <span class="wpe-meta-value">{{ item.value }}</span>
            </div>
          </div>
          <div v-for="section in selectedSummarySections" :key="section.id" class="wpe-detail-block">
            <div class="wpe-detail-label">{{ section.label }}</div>
            <div class="wpe-detail-text">{{ section.text }}</div>
          </div>
          <div v-if="selectedNode.ctx?.max > 0" class="wpe-context">
            <div class="wpe-context-copy">
              <span>上下文</span>
              <span>{{ selectedCtxPercent }}%</span>
            </div>
            <div class="wpe-context-track">
              <span class="wpe-context-fill" :style="{ width: selectedCtxPercent + '%' }"></span>
            </div>
          </div>
        </section>

        <section v-if="selectedInputSections.length" class="wpe-inspector-section">
          <div class="wpe-section-heading">输入</div>
          <div v-for="section in selectedInputSections" :key="section.id" class="wpe-detail-block">
            <div class="wpe-detail-label">{{ section.label }}</div>
            <div v-if="section.kind === 'code'" class="wpe-code-wrap">
              <button
                type="button"
                class="wpe-copy-btn"
                :title="copiedSectionId === section.id ? '已复制' : '复制'"
                @click="copySectionText(section)"
              >
                <svg v-if="copiedSectionId === section.id" viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
                  <path d="m4.5 10.5 3.2 3.2 7.8-8.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg v-else viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
                  <rect x="7" y="7" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
                  <path d="M4 12V5.8C4 4.8 4.8 4 5.8 4H12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </button>
              <pre class="wpe-code">{{ section.text }}</pre>
            </div>
            <div v-else class="wpe-detail-text">{{ section.text }}</div>
            <div v-if="section.options?.length" class="wpe-options">
              <span v-for="option in section.options" :key="option" class="wpe-option">{{ option }}</span>
            </div>
          </div>
        </section>

        <section v-if="selectedOutputSections.length" class="wpe-inspector-section">
          <div class="wpe-section-heading">输出</div>
          <div v-for="section in selectedOutputSections" :key="section.id" class="wpe-detail-block">
            <div class="wpe-detail-label">{{ section.label }}</div>
            <div v-if="section.kind === 'code'" class="wpe-code-wrap">
              <button
                type="button"
                class="wpe-copy-btn"
                :title="copiedSectionId === section.id ? '已复制' : '复制'"
                @click="copySectionText(section)"
              >
                <svg v-if="copiedSectionId === section.id" viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
                  <path d="m4.5 10.5 3.2 3.2 7.8-8.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg v-else viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
                  <rect x="7" y="7" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" />
                  <path d="M4 12V5.8C4 4.8 4.8 4 5.8 4H12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </button>
              <pre class="wpe-code result">{{ section.text }}</pre>
            </div>
            <div v-else class="wpe-detail-text" :class="{ muted: section.muted }">{{ section.text }}</div>
          </div>
        </section>
      </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, ref, watch, nextTick, onUnmounted } from 'vue'
import { buildExecutionTree } from '../../utils/executionTreeBuilder'
import ExecutionTimelineNode from './ExecutionTimelineNode.vue'

const props = defineProps({
  executionSteps: { type: Array, default: () => [] },
  subtasks: { type: Array, default: () => [] },
  running: { type: Boolean, default: false },
  sessionId: { type: String, default: '' },
})

const listRef = ref(null)
const selectedNode = ref(null)
const copiedSectionId = ref('')
let copiedResetTimer = null
const nodes = computed(() => buildExecutionTree(props.executionSteps, props.subtasks))
const flatNodes = computed(() => flattenNodes(nodes.value))
const focusNode = computed(() => findFocusNode(flatNodes.value))
const focusKey = computed(() => focusNode.value ? getNodeKey(focusNode.value) : '')
const selectedKey = computed(() => selectedNode.value ? getNodeKey(selectedNode.value) : '')

const selectedPreviewResult = computed(() => selectedNode.value?.result_preview ?? selectedNode.value?.result ?? '')
const selectedArguments = computed(() => {
  const args = selectedNode.value?.arguments
  return asRecord(parseMaybeJson(args) ?? args)
})
const selectedParsedPreview = computed(() => parseMaybeJson(selectedPreviewResult.value))
const selectedRawResult = computed(() => parseMaybeJson(selectedNode.value?.raw_result))
const selectedResultPayload = computed(() => selectedRawResult.value || selectedParsedPreview.value || null)
const selectedResultContent = computed(() => {
  const payload = selectedResultPayload.value
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'content')) {
    return payload.content
  }
  return payload
})
const selectedResultMetadata = computed(() => asRecord(selectedResultPayload.value?.metadata))
const hasSelectedArguments = computed(() => {
  return Object.keys(selectedArguments.value).length > 0
})
const formattedSelectedArguments = computed(() => formatContent(hasSelectedArguments.value ? selectedArguments.value : selectedNode.value?.arguments, 1600))
const formattedSelectedResult = computed(() => formatContent(selectedPreviewResult.value, 1600))
const selectedCtxPercent = computed(() => {
  const ctx = selectedNode.value?.ctx
  if (!ctx?.max) return 0
  return Math.min(100, Math.round((ctx.used / ctx.max) * 100))
})
const selectedStatusLabel = computed(() => {
  const label = {
    running: '执行中',
    success: '完成',
    error: '失败',
    stopped: '已停止',
    pending: '等待',
  }
  return label[normalizeStatus(selectedNode.value?.status)] || selectedNode.value?.status || '未知'
})
const selectedElapsedLabel = computed(() => formatElapsed(selectedNode.value?.elapsed_time))
const selectedInspectorMeta = computed(() => {
  const node = selectedNode.value
  if (!node) return []
  const meta = [{ label: '状态', value: selectedStatusLabel.value }]
  if (selectedElapsedLabel.value) meta.push({ label: '耗时', value: selectedElapsedLabel.value })
  if (node.type === 'agent_call') {
    const agent = node.agent_display_name || node.agent_name || node.agent
    if (agent) meta.push({ label: 'Agent', value: agent })
  }
  if (node.type === 'tool_call' && node.tool_name) meta.push({ label: '工具', value: node.tool_name })
  if (node.type === 'tool_call') {
    meta.push(...buildToolMeta(
      node,
      selectedArguments.value,
      selectedResultContent.value,
      selectedResultMetadata.value,
      selectedResultPayload.value,
    ))
  }
  if (node.type === 'thought' && node.round) meta.push({ label: '轮次', value: String(node.round) })
  return dedupeMeta(meta).slice(0, 10)
})
const selectedSummarySections = computed(() => {
  const node = selectedNode.value
  if (!node) return []
  if (node.type === 'agent_call' && node.description) {
    return [{ id: 'summary-agent-task', label: '任务', text: node.description }]
  }
  if (node.type === 'thought') {
    const text = node.intent || node.thought || node.thinking || node.description || inspectorTitle.value
    return text ? [{ id: 'summary-thought', label: '内容', text }] : []
  }
  if (node.type !== 'tool_call') {
    const text = node.description || inspectorTitle.value
    return text ? [{ id: 'summary-content', label: '内容', text }] : []
  }
  return buildToolSummarySections(
    node,
    selectedArguments.value,
    selectedResultContent.value,
    selectedResultMetadata.value,
    selectedResultPayload.value,
  )
})
const selectedInputSections = computed(() => {
  const node = selectedNode.value
  if (!node || node.type !== 'tool_call') return []
  const args = selectedArguments.value
  const specialized = buildToolInputSections(node, args)
  if (specialized.length) return specialized
  if (!hasSelectedArguments.value) return []
  return [{ id: 'input-args', label: '参数', text: formattedSelectedArguments.value, kind: 'code' }]
})
const selectedOutputSections = computed(() => {
  const node = selectedNode.value
  if (!node) return []
  if (node.type === 'agent_call' && node.result_summary) {
    return [{ id: 'output-agent-result', label: '结果', text: node.result_summary }]
  }
  if (node.type !== 'tool_call') return []
  const specialized = buildToolOutputSections(
    node,
    selectedArguments.value,
    selectedResultContent.value,
    selectedResultMetadata.value,
    selectedResultPayload.value,
  )
  if (specialized.length) return specialized
  if (!selectedPreviewResult.value) return []
  return [{ id: 'output-result', label: '执行结果', text: formattedSelectedResult.value, kind: 'code' }]
})
const inspectorTypeLabel = computed(() => {
  if (!selectedNode.value) return ''
  if (selectedNode.value.type === 'agent_call') return 'Agent 详情'
  if (selectedNode.value.type === 'tool_call') return getToolInspectorLabel(selectedNode.value.tool_name)
  if (selectedNode.value.type === 'thought') return selectedNode.value.round ? `轮次 ${selectedNode.value.round}` : '思考详情'
  return '执行详情'
})
const inspectorTitle = computed(() => {
  const node = selectedNode.value
  if (!node) return ''
  if (node.type === 'agent_call') return node.agent_display_name || node.agent_name || node.description || 'Agent'
  if (node.type === 'tool_call') return getToolDisplayName(node)
  return node.intent || node.thought || node.thinking || node.description || '执行步骤'
})
const focusStripLabel = computed(() => {
  if (!focusNode.value) return ''
  const status = normalizeStatus(focusNode.value.status)
  if (status === 'error') return '失败'
  if (status === 'running') return '当前'
  if (focusNode.value.tool_name === 'request_user_input') return '待输入'
  return '最新'
})
const focusStripTitle = computed(() => getNodeTitle(focusNode.value))

const stats = computed(() => {
  const values = { total: 0, agent: 0, tool: 0, running: 0, success: 0, error: 0 }
  flatNodes.value.forEach(node => {
    values.total += 1
    if (node.type === 'agent_call') values.agent += 1
    if (node.type === 'tool_call') values.tool += 1
    const status = normalizeStatus(node.status)
    if (status === 'running') values.running += 1
    if (status === 'success') values.success += 1
    if (status === 'error') values.error += 1
  })
  return values
})

const summaryText = computed(() => {
  if (!stats.value.total) return props.running ? '准备中' : '无记录'
  const parts = [`${stats.value.total} 步`]
  if (stats.value.agent) parts.push(`${stats.value.agent} Agent`)
  if (stats.value.tool) parts.push(`${stats.value.tool} 工具`)
  return parts.join(' / ')
})

const scrollSignature = computed(() => flatNodes.value.map((node, index) => [
  index,
  node.type,
  node.call_id || node.task_id || node.round || '',
  node.status || '',
  node.children?.length || 0,
].join(':')).join('|'))

watch(scrollSignature, async () => {
  if (!props.running) return
  const shouldFollow = !listRef.value || isListNearBottom(listRef.value)
  await nextTick()
  const el = listRef.value
  if (el && shouldFollow) el.scrollTop = el.scrollHeight
})

watch(focusNode, (node) => {
  if (!selectedNode.value && node) {
    selectedNode.value = node
  }
})

onUnmounted(() => {
  if (copiedResetTimer) clearTimeout(copiedResetTimer)
})

function flattenNodes(items = []) {
  const result = []
  const walk = (children) => {
    children.forEach(child => {
      result.push(child)
      if (Array.isArray(child.children) && child.children.length > 0) {
        walk(child.children)
      }
    })
  }
  walk(items)
  return result
}

function normalizeStatus(status) {
  if (status === 'completed' || status === 'success') return 'success'
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'cancelled' || status === 'stopped') return 'stopped'
  if (status === 'running') return 'running'
  return status || 'pending'
}

function formatElapsed(value) {
  if (value === null || value === undefined || value === '') return ''
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))}ms`
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m${rest}s`
}

function buildToolMeta(node, args, content, metadata, payload) {
  const name = node?.tool_name || ''
  const meta = []
  const add = (label, value) => pushMeta(meta, label, value)

  if (name === 'execute_bash') {
    add('工作目录', compactPath(pickString(metadata.working_dir, args.working_dir)))
    add('退出码', firstNumber(content?.return_code, content?.exit_code, metadata.return_code, metadata.exit_code))
    add('风险', riskLabel(pickString(metadata.risk_level)))
    add('分类', pickString(content?.classification, metadata.classification))
    add('后台任务', pickString(content?.background_task_id, metadata.background_task_id))
    return meta
  }

  if (name === 'execute_code') {
    add('工具调用', countLabel(firstNumber(metadata.tool_calls_count, content?.tool_calls_count)))
    add('执行耗时', formatElapsed(firstNumber(metadata.execution_time)))
    add('分类', pickString(metadata.classification))
    return meta
  }

  if (['read_file', 'write_file', 'edit_file', 'preview_data_structure'].includes(name)) {
    const path = pickString(content?.display_path, metadata.display_path, content?.file_path, metadata.file_path, args.file_path)
    add('文件', compactPath(path))
    add('大小', formatBytes(firstNumber(content?.file_size, metadata.file_size)))
    if (name === 'read_file') add('行号', lineRangeLabel(metadata))
    if (name === 'edit_file') add('替换', countLabel(firstNumber(content?.replacements, metadata.replacements), '处'))
    if (name === 'preview_data_structure') add('结构', previewDataShape(content))
    return meta
  }

  if (name === 'grep' || name === 'glob') {
    add(name === 'glob' ? '匹配模式' : '搜索词', truncateText(pickString(args.pattern, args.query, args.glob), 42))
    add('路径', compactPath(args.path || '.'))
    add('结果', searchCountLabel(name, args, content))
    add('耗时', formatDurationMs(firstNumber(content?.durationMs, metadata.durationMs)))
    return meta
  }

  if (name === 'web_fetch') {
    add('URL', compactUrl(pickString(content?.url, args.url)))
    add('字符数', countLabel(firstNumber(content?.total_length), '字符'))
    add('截断', content?.truncated ? '是' : '')
    return meta
  }

  if (name === 'request_user_input') {
    add('输入类型', args.input_type === 'select' ? '选择' : '文本')
    add('选项', countLabel(countFrom(args.options), '项'))
    return meta
  }

  if (name === 'call_agent') {
    add('目标 Agent', pickString(args.agent_name, payload?.metadata?.agent_name, content?.metadata?.agent_name))
    add('子会话', pickString(payload?.metadata?.child_agent_id, content?.metadata?.child_agent_id))
    return meta
  }

  if (name.includes('skill')) {
    add('Skill', pickString(args.skill_name, content?.skill, content?.skill_name, metadata.skill, metadata.skill_name))
    add('脚本', pickString(args.script_name, content?.script_name, metadata.script_name))
    add('资源', pickString(args.resource_file, content?.file_name))
    add('返回码', firstNumber(content?.return_code))
    add('Artifact', pickString(content?.artifact_id, metadata.artifact_id))
    add('Team', pickString(content?.team_name, metadata.team_name))
    return meta
  }

  if (name === 'todo_write') {
    add('待办', countLabel(firstNumber(metadata.count, countFrom(content?.new_todos), countFrom(args.todos)), '项'))
    add('进行中', firstNumber(metadata.in_progress))
    add('已完成', firstNumber(metadata.completed))
    return meta
  }

  if (name.startsWith('task_')) {
    const task = asRecord(content?.task)
    add('任务 ID', pickString(args.task_id, task.id, content?.task_id, metadata.task_id))
    add('状态', statusLabel(pickString(args.status, task.status, metadata.status)))
    add('数量', countLabel(firstNumber(content?.total, content?.items?.length, metadata.total), '项'))
    return meta
  }

  if (name.includes('memory')) {
    add('记忆', pickString(args.name, args.file_name, content?.file_name, content?.name, metadata.file_name))
    add('数量', countLabel(firstNumber(content?.count, content?.items?.length, metadata.count), '项'))
  }

  return meta
}

function buildToolSummarySections(node, args, content, metadata, payload) {
  const name = node?.tool_name || ''
  const sections = []
  const summary = pickString(payload?.summary, content?.summary, content?.message, payload?.message)

  if (name === 'execute_bash') {
    sections.push(section('summary-bash-desc', '用途', args.description))
    sections.push(section('summary-tool-result', '结果摘要', summary))
    return compactSections(sections)
  }

  if (name === 'execute_code') {
    sections.push(section('summary-code-desc', '用途', args.description))
    sections.push(section('summary-tool-result', '结果摘要', summary))
    return compactSections(sections)
  }

  if (name === 'call_agent') {
    sections.push(section('summary-agent-task', '任务', args.task))
    sections.push(section('summary-agent-context', '上下文', args.context_hint))
    sections.push(section('summary-tool-result', '结果摘要', summary))
    return compactSections(sections)
  }

  if (name === 'request_user_input') {
    sections.push(section('summary-input-state', '状态', normalizeStatus(node.status) === 'running' ? '等待用户输入' : summary))
    return compactSections(sections)
  }

  if (['read_file', 'write_file', 'edit_file', 'preview_data_structure'].includes(name)) {
    const path = pickString(content?.display_path, metadata.display_path, content?.file_path, metadata.file_path, args.file_path)
    sections.push(section('summary-file-target', '目标', compactPath(path, 56)))
    sections.push(section('summary-tool-result', '结果摘要', summary))
    return compactSections(sections)
  }

  if (name.includes('skill')) {
    sections.push(section('summary-skill-result', '结果摘要', summary))
    return compactSections(sections)
  }

  sections.push(section('summary-tool-result', '结果摘要', summary))
  return compactSections(sections)
}

function buildToolInputSections(node, args) {
  const name = node?.tool_name || ''
  const sections = []

  if (name === 'request_user_input') {
    sections.push({
      id: 'input-prompt',
      label: '问题',
      text: String(args.prompt || ''),
      options: normalizeOptions(args.options),
    })
    return compactSections(sections)
  }

  if (name === 'execute_bash') {
    sections.push(section('input-bash-command', '命令', args.command, 'code'))
    sections.push(section('input-bash-dir', '工作目录', formatPairs([
      ['目录', args.working_dir || '.'],
      ['空间', args.working_dir_space],
      ['超时', args.timeout ? `${args.timeout}s` : ''],
      ['后台执行', args.run_in_background ? '是' : ''],
    ])))
    return compactSections(sections)
  }

  if (name === 'execute_code') {
    sections.push(section('input-code-desc', '用途', args.description))
    sections.push(section('input-code-body', '代码', args.code, 'code'))
    sections.push(section('input-code-options', '选项', formatPairs([
      ['超时', args.timeout ? `${args.timeout}s` : ''],
    ])))
    return compactSections(sections)
  }

  if (name === 'read_file') {
    sections.push(section('input-file-read', '读取范围', formatPairs([
      ['文件', args.file_path],
      ['空间', args.file_path_space],
      ['编码', args.encoding],
      ['起始行', args.offset],
      ['行数限制', args.limit],
    ])))
    return compactSections(sections)
  }

  if (name === 'write_file') {
    sections.push(section('input-file-write-target', '保存位置', formatPairs([
      ['文件', args.file_path || '自动分配'],
      ['空间', args.file_path_space],
      ['编码', args.encoding],
    ])))
    sections.push(section('input-file-write-content', '写入内容', args.content, 'code'))
    return compactSections(sections)
  }

  if (name === 'edit_file') {
    sections.push(section('input-file-edit-target', '编辑目标', formatPairs([
      ['文件', args.file_path],
      ['空间', args.file_path_space],
      ['替换全部', args.replace_all ? '是' : '否'],
    ])))
    sections.push(section('input-file-edit-old', '原内容', args.old_string, 'code'))
    sections.push(section('input-file-edit-new', '新内容', args.new_string, 'code'))
    return compactSections(sections)
  }

  if (name === 'preview_data_structure') {
    sections.push(section('input-data-preview', '预览参数', formatPairs([
      ['文件', args.file_path],
      ['最大行数', args.max_preview_rows],
      ['最大深度', args.max_depth],
      ['最大字段', args.max_fields],
    ])))
    return compactSections(sections)
  }

  if (name === 'grep') {
    sections.push(section('input-grep-pattern', '正则', args.pattern, 'code'))
    sections.push(section('input-grep-options', '搜索范围', formatPairs([
      ['路径', args.path || '.'],
      ['文件过滤', args.glob],
      ['输出模式', args.output_mode],
      ['文件类型', args.file_type],
      ['忽略大小写', args.case_insensitive ? '是' : ''],
      ['上下文', args.context ?? ''],
      ['结果限制', args.head_limit],
    ])))
    return compactSections(sections)
  }

  if (name === 'glob') {
    sections.push(section('input-glob-pattern', '匹配模式', args.pattern, 'code'))
    sections.push(section('input-glob-path', '搜索路径', args.path || '.'))
    return compactSections(sections)
  }

  if (name === 'web_fetch') {
    sections.push(section('input-web-url', 'URL', args.url))
    sections.push(section('input-web-options', '选项', formatPairs([
      ['原始 HTML', args.raw ? '是' : '否'],
      ['最大长度', args.max_length],
      ['起始位置', args.start_index],
    ])))
    return compactSections(sections)
  }

  if (name === 'call_agent') {
    sections.push(section('input-agent-name', '目标 Agent', args.agent_name))
    sections.push(section('input-agent-task', '任务', args.task))
    sections.push(section('input-agent-context', '上下文提示', args.context_hint))
    return compactSections(sections)
  }

  if (name.includes('skill')) {
    sections.push(section('input-skill-target', 'Skill', formatPairs([
      ['名称', args.skill_name],
      ['脚本', args.script_name],
      ['资源', args.resource_file],
      ['后台执行', args.run_in_background ? '是' : ''],
    ])))
    sections.push(section('input-skill-args', '脚本参数', args.arguments ? formatContent(args.arguments, 1200) : '', 'code'))
    return compactSections(sections)
  }

  if (name === 'todo_write') {
    sections.push(section('input-todos', '待办列表', formatTodoList(args.todos), 'code'))
    return compactSections(sections)
  }

  if (name.startsWith('task_')) {
    if (name === 'task_create') {
      sections.push(section('input-task-subject', '任务标题', args.subject))
      sections.push(section('input-task-desc', '任务描述', args.description))
      sections.push(section('input-task-meta', '附加字段', formatContent(pickObject(args, ['active_form', 'metadata']), 1200), 'code'))
      return compactSections(sections)
    }
    sections.push(section('input-task-args', '任务参数', formatContent(args, 1200), 'code'))
    return compactSections(sections)
  }

  return []
}

function buildToolOutputSections(node, args, content, metadata, payload) {
  const name = node?.tool_name || ''
  const sections = []
  const summary = pickString(payload?.summary, content?.summary, content?.message, payload?.message)

  if (name === 'request_user_input') {
    const answer = pickString(content, node.result_preview, node.result)
    if (answer && answer !== '（已取消）') {
      sections.push(section('output-user-answer', '回答', stripToolHeader(answer)))
    } else if (normalizeStatus(node.status) === 'running') {
      sections.push(section('output-input-waiting', '状态', '等待用户输入中', 'text', { muted: true }))
    }
    return compactSections(sections)
  }

  if (name === 'execute_bash') {
    if (Array.isArray(content?.background_notifications)) {
      sections.push(section('output-bash-bg', '后台通知', formatContent(content.background_notifications, 1800), 'code'))
    }
    if (content?.background_started || metadata.background_started) {
      sections.push(section('output-bash-bg-start', '后台任务', formatPairs([
        ['任务 ID', content?.background_task_id || metadata.background_task_id],
        ['输出路径', metadata.background_output_path],
      ])))
    }
    sections.push(section('output-bash-stdout', 'stdout', content?.stdout, 'code'))
    sections.push(section('output-bash-stderr', 'stderr', content?.stderr, 'code'))
    sections.push(section('output-bash-summary', '结果摘要', summary || stripToolHeader(node.result_preview)))
    return compactSections(sections)
  }

  if (name === 'execute_code') {
    sections.push(section('output-code-stdout', 'stdout', metadata.stdout, 'code'))
    if (content !== null && content !== undefined && content !== '') {
      sections.push(section('output-code-result', '返回值', formatContent(content, 1800), typeof content === 'string' ? 'text' : 'code'))
    }
    sections.push(section('output-code-summary', '结果摘要', summary || stripToolHeader(node.result_preview)))
    return compactSections(sections)
  }

  if (name === 'read_file') {
    sections.push(section(
      'output-read-file',
      metadata.preview_only ? '预览内容' : '文件内容',
      typeof content === 'string' ? content : '',
      'code',
    ))
    sections.push(section('output-read-summary', '结果摘要', summary))
    return compactSections(sections)
  }

  if (name === 'write_file') {
    sections.push(section('output-write-file', '保存结果', formatPairs([
      ['文件', content?.display_path || content?.file_path || metadata.file_path],
      ['大小', formatBytes(content?.file_size || metadata.file_size)],
    ])))
    sections.push(section('output-write-summary', '结果摘要', summary))
    return compactSections(sections)
  }

  if (name === 'edit_file') {
    sections.push(section('output-edit-diff', 'Diff', content?.diff_preview, 'code'))
    sections.push(section('output-edit-summary', '结果摘要', summary))
    return compactSections(sections)
  }

  if (name === 'preview_data_structure') {
    sections.push(section('output-data-structure', '结构预览', formatContent(content, 1800), 'code'))
    return compactSections(sections)
  }

  if (name === 'grep') {
    sections.push(section('output-grep-error', '错误', content?.error))
    sections.push(section('output-grep-matches', '命中结果', formatList(content?.matches), 'code'))
    sections.push(section('output-grep-raw', '原始输出', content?.output, 'code'))
    return compactSections(sections)
  }

  if (name === 'glob') {
    sections.push(section('output-glob-error', '错误', content?.error))
    sections.push(section('output-glob-files', '文件列表', formatList(content?.filenames), 'code'))
    return compactSections(sections)
  }

  if (name === 'web_fetch') {
    sections.push(section('output-web-error', '错误', content?.error))
    sections.push(section('output-web-content', content?.truncated ? '内容预览' : '页面内容', content?.content, 'code'))
    return compactSections(sections)
  }

  if (name === 'call_agent') {
    sections.push(section('output-agent-summary', '结果摘要', summary))
    if (content !== null && content !== undefined && content !== '') {
      sections.push(section('output-agent-content', '结果内容', formatContent(content, 1800), typeof content === 'string' ? 'text' : 'code'))
    }
    return compactSections(sections)
  }

  if (name.includes('skill')) {
    sections.push(section('output-skill-stdout', 'stdout', content?.stdout, 'code'))
    sections.push(section('output-skill-stderr', 'stderr', content?.stderr, 'code'))
    if (content?.main_content) {
      sections.push(section('output-skill-main', 'SKILL.md', content.main_content, 'code'))
    } else if (content?.content && typeof content.content === 'string') {
      sections.push(section('output-skill-content', '资源内容', content.content, 'code'))
    } else if (content !== null && content !== undefined && content !== '') {
      sections.push(section('output-skill-json', '结构化结果', formatContent(content, 1800), 'code'))
    }
    sections.push(section('output-skill-summary', '结果摘要', summary))
    return compactSections(sections)
  }

  if (name === 'todo_write' || name.startsWith('task_') || name.includes('memory')) {
    if (content !== null && content !== undefined && content !== '') {
      sections.push(section('output-structured-content', '结构化结果', formatContent(content, 1800), 'code'))
    }
    sections.push(section('output-structured-summary', '结果摘要', summary))
    return compactSections(sections)
  }

  return []
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return []
  return options
    .map(option => {
      if (option && typeof option === 'object') {
        const value = option.label ?? option.value ?? option.name
        return value == null ? JSON.stringify(option) : String(value)
      }
      return option == null ? '' : String(option)
    })
    .filter(Boolean)
}

async function copyToClipboard(text) {
  const value = String(text || '')
  if (!value) return false
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function' &&
      typeof window !== 'undefined' &&
      window.isSecureContext
    ) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Fall through to the textarea fallback.
  }

  if (typeof document === 'undefined') return false
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return Boolean(document.execCommand && document.execCommand('copy'))
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}

function nodeKey(node, index) {
  return node.call_id || node.task_id || `${node.type}-${node.round || ''}-${index}`
}

function getNodeKey(node) {
  if (!node) return ''
  if (node.call_id) return `call:${node.call_id}`
  if (node.task_id) return `task:${node.task_id}`
  const identity = node.tool_name || node.agent_name || node.agent || node.agent_display_name || node.intent || node.description || ''
  return `${node.type || 'node'}:${node.round || ''}:${String(identity).slice(0, 80)}`
}

function selectNode(node) {
  selectedNode.value = node
}

async function copySectionText(section) {
  const text = String(section?.text || '')
  if (!text) return
  const ok = await copyToClipboard(text)
  if (!ok) return
  copiedSectionId.value = section.id
  if (copiedResetTimer) clearTimeout(copiedResetTimer)
  copiedResetTimer = setTimeout(() => {
    if (copiedSectionId.value === section.id) copiedSectionId.value = ''
  }, 1200)
}

async function focusNodeInList(node) {
  if (!node) return
  selectedNode.value = node
  await nextTick()
  scrollNodeIntoView(getNodeKey(node))
}

function focusErrorNode() {
  const node = findLastByStatus('error')
  focusNodeInList(node)
}

function focusRunningNode() {
  const node = findLastByStatus('running')
  focusNodeInList(node)
}

function findLastByStatus(status) {
  for (let i = flatNodes.value.length - 1; i >= 0; i -= 1) {
    if (normalizeStatus(flatNodes.value[i]?.status) === status) return flatNodes.value[i]
  }
  return null
}

function scrollNodeIntoView(key) {
  if (!key || !listRef.value) return
  const selectorKey = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/"/g, '\\"')
  const target = listRef.value.querySelector(`[data-node-key="${selectorKey}"]`)
  if (!target) return
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' })
}

function isListNearBottom(el) {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 36
}

function findFocusNode(items) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (normalizeStatus(items[i]?.status) === 'error') return items[i]
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (normalizeStatus(items[i]?.status) === 'running') return items[i]
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.tool_name === 'request_user_input') return items[i]
  }
  return items[items.length - 1] || null
}

function getToolDisplayName(node) {
  const name = node?.tool_name || ''
  if (name === 'request_user_input') return '请求用户输入'
  const args = asRecord(parseMaybeJson(node?.arguments) ?? node?.arguments)
  const skillNames = {
    activate_skill: `激活 ${args.skill_name || 'Skill'}`,
    load_skill_resource: `加载 ${args.skill_name || 'Skill'} 资源`,
    execute_skill_script: `执行 ${args.skill_name || 'Skill'} 脚本`,
    get_skill_info: `查询 ${args.skill_name || 'Skill'} 信息`,
  }
  return skillNames[name] || name || '工具调用'
}

function getNodeTitle(node) {
  if (!node) return ''
  if (node.type === 'agent_call') {
    return node.description || node.result_summary || node.agent_display_name || node.agent_name || 'Agent'
  }
  if (node.type === 'tool_call') {
    return getToolDisplayName(node)
  }
  return node.intent || node.thought || node.thinking || node.description || '执行步骤'
}

function getToolInspectorLabel(toolName = '') {
  const name = String(toolName || '')
  if (name === 'execute_bash') return '命令详情'
  if (name === 'execute_code') return '代码详情'
  if (['read_file', 'write_file', 'edit_file', 'preview_data_structure'].includes(name)) return '文件详情'
  if (name === 'grep' || name === 'glob') return '搜索详情'
  if (name === 'web_fetch') return '网页详情'
  if (name === 'request_user_input') return '输入详情'
  if (name === 'call_agent') return 'Agent 调用'
  if (name.includes('skill')) return 'Skill 详情'
  if (name === 'todo_write' || name.startsWith('task_')) return '任务详情'
  if (name.includes('memory')) return '记忆详情'
  return '工具详情'
}

function parseMaybeJson(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function pushMeta(target, label, value) {
  const text = normalizeDisplayValue(value)
  if (!text) return
  target.push({ label, value: text })
}

function dedupeMeta(items) {
  const seen = new Set()
  return items.filter(item => {
    const key = item.label
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function section(id, label, text, kind = 'text', extra = {}) {
  const value = kind === 'code' ? normalizeCodeValue(text) : normalizeDisplayValue(text, true)
  if (!value) return null
  return { id, label, text: value, kind, ...extra }
}

function compactSections(sections) {
  return sections.filter(Boolean)
}

function normalizeDisplayValue(value, multiline = false) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'string') {
    const text = value.trim()
    return multiline ? text : text.replace(/\s+/g, ' ')
  }
  return formatContent(value, multiline ? 1600 : 240).replace(/\s+/g, ' ').trim()
}

function normalizeCodeValue(value) {
  if (value === null || value === undefined) return ''
  const maxLength = 2400
  const text = typeof value === 'string' ? value.trim() : formatContent(value, maxLength)
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...` : text
}

function pickString(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      const nested = pickString(...value)
      if (nested) return nested
      continue
    }
    if (typeof value === 'string') {
      const text = value.trim()
      if (text) return text
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  }
  return ''
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return null
}

function countFrom(value) {
  if (Array.isArray(value)) return value.length
  const number = firstNumber(value)
  return number == null ? null : number
}

function countLabel(value, unit = '') {
  const number = firstNumber(value)
  if (number == null) return ''
  return `${formatCount(number)}${unit}`
}

function searchCountLabel(name, args, content) {
  if (name === 'glob') return countLabel(firstNumber(content?.numFiles, countFrom(content?.filenames)), ' 个文件')
  const unit = args.output_mode === 'files_with_matches' ? ' 个文件' : ' 条'
  return countLabel(firstNumber(content?.count, countFrom(content?.matches)), unit)
}

function formatCount(value) {
  const number = firstNumber(value)
  if (number == null) return ''
  return number.toLocaleString('zh-CN')
}

function formatBytes(value) {
  const bytes = firstNumber(value)
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

function formatDurationMs(value) {
  const ms = firstNumber(value)
  if (ms == null) return ''
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  return formatElapsed(ms / 1000)
}

function lineRangeLabel(metadata) {
  const start = firstNumber(metadata.start_line)
  const end = firstNumber(metadata.end_line)
  const total = firstNumber(metadata.total_lines)
  if (start == null || end == null) return ''
  return `${start}-${end}${total != null ? `/${total}` : ''}`
}

function compactPath(value, max = 38) {
  const text = pickString(value).replace(/\\/g, '/')
  if (!text) return ''
  if (text.length <= max) return text
  const parts = text.split('/').filter(Boolean)
  const tail = parts.slice(-2).join('/')
  if (tail && tail.length + 4 <= max) return `.../${tail}`
  return truncateText(text, max)
}

function compactUrl(value) {
  const text = pickString(value)
  if (!text) return ''
  try {
    const parsed = new URL(text.includes('://') ? text : `https://${text}`)
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/$/, '') : ''
    return truncateText(`${parsed.hostname}${path}`, 42)
  } catch {
    return truncateText(text, 42)
  }
}

function truncateText(value, max) {
  const text = String(value || '').trim()
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function stripToolHeader(value) {
  return String(value || '').replace(/^\[[^\]]+\]\s*/, '').trim()
}

function formatPairs(pairs) {
  return pairs
    .map(([label, value]) => {
      const text = normalizeDisplayValue(value)
      return text ? `${label}: ${text}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

function formatList(items) {
  if (!Array.isArray(items)) return ''
  return items.map(item => normalizeDisplayValue(item, true)).filter(Boolean).join('\n')
}

function formatTodoList(todos) {
  if (!Array.isArray(todos)) return ''
  return todos
    .map((todo, index) => {
      const status = statusLabel(todo?.status)
      const content = pickString(todo?.content, todo?.active_form)
      return `${index + 1}. ${status ? `[${status}] ` : ''}${content}`
    })
    .join('\n')
}

function pickObject(source, keys) {
  const result = {}
  keys.forEach(key => {
    if (source?.[key] !== undefined && source?.[key] !== null && source?.[key] !== '') {
      result[key] = source[key]
    }
  })
  return result
}

function previewDataShape(value) {
  if (!value) return ''
  if (Array.isArray(value)) return `${value.length} 项`
  if (typeof value !== 'object') return ''
  const featureCount = firstNumber(value.feature_count, value.features?.length)
  if (featureCount != null) return `${formatCount(featureCount)} 个要素`
  const rows = firstNumber(value.row_count, value.rows?.length, value.records?.length)
  const columns = firstNumber(value.column_count, value.columns?.length, value.fields?.length)
  if (rows != null && columns != null) return `${formatCount(rows)} 行 ${formatCount(columns)} 列`
  if (rows != null) return `${formatCount(rows)} 行`
  if (columns != null) return `${formatCount(columns)} 个字段`
  return `${Object.keys(value).length} 个字段`
}

function riskLabel(value) {
  const labels = {
    low: '低',
    medium: '中',
    high: '高',
  }
  return labels[value] || value || ''
}

function statusLabel(status) {
  const labels = {
    pending: '待处理',
    in_progress: '进行中',
    running: '进行中',
    completed: '已完成',
    success: '已完成',
    deleted: '已删除',
    error: '失败',
    failed: '失败',
    stopped: '已停止',
    cancelled: '已停止',
  }
  return labels[status] || status || ''
}

function formatContent(value, maxLength) {
  if (value === null || value === undefined) return ''
  let text = ''
  if (typeof value === 'string') {
    const parsed = parseMaybeJson(value)
    text = parsed && typeof parsed !== 'string' ? JSON.stringify(parsed, null, 2) : value
  } else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...` : text
}
</script>

<style scoped>
.wpe-root {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid var(--color-border);
  letter-spacing: 0;
  animation: wpe-root-enter 220ms ease-out both;
}

.wpe-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 12px 14px 10px;
  flex-shrink: 0;
  animation: wpe-header-enter 180ms ease-out 40ms both;
}

.wpe-heading {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

.wpe-title {
  font-size: 13px;
  line-height: 1.25;
  font-weight: 650;
  color: var(--color-text-primary);
}

.wpe-summary {
  font-size: 11px;
  line-height: 1.25;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--transition-fast);
}

.wpe-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.wpe-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  font-size: 11px;
  font-weight: 650;
  line-height: 1;
  white-space: nowrap;
  font-family: inherit;
  cursor: default;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast),
    color var(--transition-fast);
}

button.wpe-chip {
  cursor: pointer;
}

button.wpe-chip:hover {
  border-color: var(--color-border-hover);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.42);
}

.chip-running {
  color: var(--color-brand-accent);
  border-color: rgba(var(--color-brand-accent-rgb), 0.26);
  background: rgba(var(--color-brand-accent-rgb), 0.1);
}

.chip-running:hover {
  border-color: rgba(var(--color-brand-accent-rgb), 0.34);
  background: rgba(var(--color-brand-accent-rgb), 0.14);
}

.chip-error {
  color: var(--color-error);
  border-color: rgba(var(--color-error-rgb), 0.24);
  background: rgba(var(--color-error-rgb), 0.09);
}

.chip-error:hover {
  border-color: rgba(var(--color-error-rgb), 0.34);
  background: rgba(var(--color-error-rgb), 0.13);
}

.chip-success {
  color: var(--color-success);
  border-color: rgba(var(--color-success-rgb), 0.22);
  background: rgba(var(--color-success-rgb), 0.08);
}

.wpe-running-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-brand-accent, #6366f1);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

.wpe-empty {
  margin: 0 14px;
  padding: 14px 12px;
  font-size: 12px;
  color: var(--color-text-muted);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.24);
  display: flex;
  align-items: center;
  gap: 8px;
}

.wpe-focus-strip {
  margin: 0 14px 10px;
  min-height: 34px;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.3);
  color: var(--color-text-secondary);
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast),
    box-shadow var(--transition-fast);
}

.wpe-focus-strip:hover {
  border-color: var(--color-border-hover);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.44);
}

.wpe-focus-strip.status-running {
  border-color: rgba(var(--color-brand-accent-rgb), 0.24);
  background: rgba(var(--color-brand-accent-rgb), 0.08);
  box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.04);
}

.wpe-focus-strip.status-running:hover {
  border-color: rgba(var(--color-brand-accent-rgb), 0.34);
  background: rgba(var(--color-brand-accent-rgb), 0.12);
}

.wpe-focus-strip.status-success {
  border-color: rgba(var(--color-success-rgb), 0.24);
  background: rgba(var(--color-success-rgb), 0.08);
  box-shadow: 0 0 0 3px rgba(var(--color-success-rgb), 0.035);
}

.wpe-focus-strip.status-success:hover {
  border-color: rgba(var(--color-success-rgb), 0.32);
  background: rgba(var(--color-success-rgb), 0.12);
}

.wpe-focus-strip.status-error {
  border-color: rgba(var(--color-error-rgb), 0.28);
  background: rgba(var(--color-error-rgb), 0.08);
  box-shadow: 0 0 0 3px rgba(var(--color-error-rgb), 0.04);
}

.wpe-focus-strip.status-error:hover {
  border-color: rgba(var(--color-error-rgb), 0.38);
  background: rgba(var(--color-error-rgb), 0.12);
}

.wpe-focus-strip.status-stopped {
  border-color: rgba(var(--color-warning-rgb), 0.26);
  background: rgba(var(--color-warning-rgb), 0.08);
  box-shadow: 0 0 0 3px rgba(var(--color-warning-rgb), 0.035);
}

.wpe-focus-strip.status-stopped:hover {
  border-color: rgba(var(--color-warning-rgb), 0.36);
  background: rgba(var(--color-warning-rgb), 0.12);
}

.wpe-focus-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--color-text-muted);
}

.wpe-focus-strip.status-running .wpe-focus-dot {
  background: var(--color-brand-accent);
  animation: pulse 1.5s ease-in-out infinite;
}

.wpe-focus-strip.status-error .wpe-focus-dot {
  background: var(--color-error);
}

.wpe-focus-strip.status-success .wpe-focus-dot {
  background: var(--color-success);
}

.wpe-focus-strip.status-stopped .wpe-focus-dot {
  background: var(--color-warning);
}

.wpe-focus-label {
  font-size: 11px;
  line-height: 1;
  font-weight: 700;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.wpe-focus-title {
  min-width: 0;
  font-size: 12px;
  line-height: 1.35;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wpe-empty-mark {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--color-border);
  flex-shrink: 0;
}

.wpe-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px 12px 10px;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
}

.wpe-node-stack {
  --rail-width: 22px;
  --rail-dot-top: 17px;
  --rail-dot-size: 9px;
  --rail-dot-center: calc(var(--rail-dot-top) + (var(--rail-dot-size) / 2));
  --timeline-rail-thickness: 2px;
  position: relative;
}

.wpe-node-stack::before {
  content: '';
  position: absolute;
  left: calc((var(--rail-width) - var(--timeline-rail-thickness)) / 2);
  top: var(--rail-dot-center);
  bottom: 0;
  width: var(--timeline-rail-thickness);
  border-radius: var(--radius-full);
  background: var(--color-border);
  opacity: 0.7;
  pointer-events: none;
  mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 14px), transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 14px), transparent 100%);
}

.wpe-node-stack:not(:has(> .etn + .etn)):not(:has(> .etn--has-children))::before {
  display: none;
}

.wpe-list::-webkit-scrollbar { width: 3px; }
.wpe-list::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 2px;
}

.wpe-inspector {
  flex-shrink: 0;
  max-height: 44%;
  min-height: 150px;
  border-top: 1px solid var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.42);
  display: flex;
  flex-direction: column;
  transform-origin: bottom;
  will-change: transform, opacity;
}

.wpe-inspector-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px 8px;
  flex-shrink: 0;
}

.wpe-inspector-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wpe-inspector-kicker {
  font-size: 10px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--color-text-muted);
}

.wpe-inspector-name {
  font-size: 12px;
  line-height: 1.35;
  font-weight: 650;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wpe-inspector-close {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.wpe-inspector-close:hover {
  background: var(--color-hover-overlay);
  color: var(--color-text-primary);
}

.wpe-inspector-body {
  min-height: 0;
  overflow: auto;
  padding: 0 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.wpe-inspector-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding-top: 10px;
  border-top: 1px solid var(--color-border);
}

.wpe-inspector-section:first-child {
  padding-top: 0;
  border-top: 0;
}

.wpe-section-heading {
  font-size: 10px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--color-text-muted);
}

.wpe-meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 10px;
}

.wpe-meta-item {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wpe-meta-label {
  font-size: 10px;
  line-height: 1.2;
  color: var(--color-text-muted);
}

.wpe-meta-value {
  min-width: 0;
  font-size: 11px;
  line-height: 1.35;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wpe-detail-block {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.wpe-detail-label {
  font-size: 10px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--color-text-muted);
}

.wpe-detail-text {
  font-size: 12px;
  line-height: 1.55;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.wpe-detail-text.muted,
.muted {
  color: var(--color-text-muted);
}

.wpe-code-wrap {
  position: relative;
  min-width: 0;
}

.wpe-copy-btn {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 1;
  width: 24px;
  height: 24px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.82);
  color: var(--color-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.wpe-copy-btn:hover {
  border-color: var(--color-border-hover);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.96);
  color: var(--color-text-primary);
}

.wpe-code {
  margin: 0;
  max-height: 190px;
  overflow: auto;
  padding: 8px 36px 8px 9px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.28);
  color: var(--color-text-secondary);
  font: 11px/1.5 var(--font-mono);
  white-space: pre-wrap;
  word-break: break-word;
}

.wpe-code.result {
  color: var(--color-result-text);
  background: var(--color-result-bg);
  border-color: var(--color-result-border);
}

.wpe-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.wpe-option {
  max-width: 100%;
  padding: 3px 7px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.28);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wpe-context {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.wpe-context-copy {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  color: var(--color-text-muted);
}

.wpe-context-track {
  height: 4px;
  border-radius: var(--radius-full);
  overflow: hidden;
  background: var(--color-border);
}

.wpe-context-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-brand-accent);
  transition: width 420ms ease;
}

.wpe-focus-enter-active,
.wpe-focus-leave-active {
  transition: opacity 180ms ease, transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.wpe-focus-enter-from,
.wpe-focus-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.wpe-list-state-enter-active,
.wpe-list-state-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}

.wpe-list-state-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.wpe-list-state-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.wpe-node-enter-active,
.wpe-node-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}

.wpe-node-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.wpe-node-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.wpe-node-move {
  transition: transform 180ms ease;
}

.wpe-inspector-enter-active,
.wpe-inspector-leave-active {
  transition:
    opacity 190ms ease,
    transform 190ms cubic-bezier(0.2, 0.8, 0.2, 1),
    max-height 190ms ease,
    min-height 190ms ease;
  overflow: hidden;
}

.wpe-inspector-enter-from,
.wpe-inspector-leave-to {
  opacity: 0;
  transform: translateY(12px);
  max-height: 0;
  min-height: 0;
}

@keyframes wpe-root-enter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes wpe-header-enter {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .wpe-root,
  .wpe-header,
  .wpe-running-dot,
  .wpe-focus-strip.status-running .wpe-focus-dot {
    animation: none;
  }

  .wpe-summary,
  .wpe-chip,
  .wpe-focus-strip,
  .wpe-inspector-close,
  .wpe-context-fill,
  .wpe-focus-enter-active,
  .wpe-focus-leave-active,
  .wpe-list-state-enter-active,
  .wpe-list-state-leave-active,
  .wpe-node-enter-active,
  .wpe-node-leave-active,
  .wpe-node-move,
  .wpe-inspector-enter-active,
  .wpe-inspector-leave-active {
    transition-duration: 1ms;
  }

  .wpe-focus-enter-from,
  .wpe-focus-leave-to,
  .wpe-list-state-enter-from,
  .wpe-list-state-leave-to,
  .wpe-node-enter-from,
  .wpe-node-leave-to,
  .wpe-inspector-enter-from,
  .wpe-inspector-leave-to {
    transform: none;
  }
}
</style>
