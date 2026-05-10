const TOOL_DISPLAY_NAMES = {
  request_user_input: '请求用户输入',
}

const SKILL_TOOL_TEMPLATES = {
  activate_skill: (args) => `激活 ${args?.skill_name || 'Skill'}`,
  load_skill_resource: (args) => `加载 ${args?.skill_name || 'Skill'} 资源`,
  execute_skill_script: (args) => `执行 ${args?.skill_name || 'Skill'} 脚本`,
  get_skill_info: (args) => `查询 ${args?.skill_name || 'Skill'} 信息`,
}

const VISUALIZATION_TOOLS = ['create_chart', 'create_map', 'create_bindmap', 'create_risk_map', 'revise_visualization']
const FILE_TOOLS = ['read_file', 'write_file', 'edit_file', 'preview_data_structure']

export function parseToolPayload(node) {
  const preview = node?.result_preview ?? node?.result ?? ''
  const args = asRecord(parseMaybeJson(node?.arguments) ?? node?.arguments)
  const parsedPreview = parseMaybeJson(preview)
  const rawResult = parseMaybeJson(node?.raw_result)
  const payload = rawResult || parsedPreview || null
  const content = payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'content')
    ? payload.content
    : payload

  return {
    args,
    preview,
    parsedPreview,
    rawResult,
    payload,
    content,
    metadata: asRecord(payload?.metadata),
  }
}

export function getToolDisplayName(nodeOrName, maybeArgs = null) {
  const name = typeof nodeOrName === 'string' ? nodeOrName : (nodeOrName?.tool_name || '')
  const args = maybeArgs || (typeof nodeOrName === 'string' ? {} : parseToolPayload(nodeOrName).args)
  if (TOOL_DISPLAY_NAMES[name]) return TOOL_DISPLAY_NAMES[name]
  const tpl = SKILL_TOOL_TEMPLATES[name]
  if (tpl) return tpl(args)
  return name || '工具调用'
}

export function getToolInspectorLabel(toolName = '') {
  const name = String(toolName || '')
  if (name === 'execute_bash') return '命令详情'
  if (name === 'execute_code') return '代码详情'
  if (FILE_TOOLS.includes(name)) return '文件详情'
  if (name === 'grep' || name === 'glob') return '搜索详情'
  if (name === 'web_fetch') return '网页详情'
  if (name === 'request_user_input') return '输入详情'
  if (name === 'call_agent') return 'Agent 调用'
  if (name.includes('skill')) return 'Skill 详情'
  if (name === 'todo_write' || name.startsWith('task_')) return '任务详情'
  if (name.includes('memory')) return '记忆详情'
  return '工具详情'
}

export function getToolIconKind(toolName = '') {
  const name = String(toolName || '').toLowerCase()
  if (name === 'request_user_input') return 'input'
  if (name === 'call_agent') return 'agentCall'
  if (name.includes('skill')) return 'skill'
  if (name.includes('map') || name.includes('geo') || name.includes('spatial') || name.includes('basin')) return 'map'
  if (name.includes('chart') || name.includes('visual') || name.includes('risk_matrix')) return 'chart'
  if (name.includes('bash') || name.includes('code') || name.includes('script') || name.includes('terminal')) return 'code'
  if (name.includes('file') || name.includes('document') || name.includes('report') || name.includes('artifact')) return 'file'
  if (name.includes('grep') || name.includes('glob') || name.includes('search') || name.includes('query') || name.includes('explore')) return 'search'
  if (name.includes('web') || name.includes('fetch') || name.includes('http') || name.includes('url')) return 'globe'
  if (name.includes('memory') || name.includes('vector') || name.includes('database') || name.includes('store')) return 'database'
  if (name.includes('task') || name.includes('todo') || name.includes('plan') || name.includes('approval')) return 'task'
  return 'tool'
}

export function getToolSubtitle(node, options = {}) {
  if (!node || node.type !== 'tool_call') return ''
  const name = node.tool_name || ''
  const { args, payload, content, metadata, preview } = parseToolPayload(node)
  const running = options.running ?? normalizeStatus(node.status) === 'running'
  const errorText = normalizeStatus(node.status) === 'error' ? getErrorText(payload, preview) : ''

  if (errorText) return truncateText(`失败: ${errorText}`, 58)
  if (name === 'call_agent') return previewCallAgent(node, args, content, running)
  if (name === 'request_user_input') return previewUserInput(args, metadata, running)
  if (name === 'execute_bash') return previewBash(args, content, metadata, running)
  if (name === 'execute_code') return previewCode(args, content, metadata, running)
  if (FILE_TOOLS.includes(name)) return previewFileTool(name, args, content, metadata, running)
  if (name === 'grep' || name === 'glob') return previewSearchTool(name, args, content, running)
  if (name === 'web_fetch') return previewWebFetch(args, content, running)
  if (name.includes('skill')) return previewSkillTool(name, args, content, metadata, running)
  if (name === 'todo_write' || name.startsWith('task_')) return previewTaskTool(name, args, content, metadata, running)
  if (name.includes('memory')) return previewMemoryTool(name, args, content, metadata, running)

  if (VISUALIZATION_TOOLS.includes(name)) {
    const title = pickString(content?.title, content?.preview?.title, payload?.title, payload?.preview?.title)
    return title ? `已生成: ${truncateText(title, 36)}` : '已生成可视化'
  }
  if (name === 'query_emergency_plan') {
    const count = countFrom(content?.results) ?? content?.total ?? payload?.total
    if (count != null) return `${count} 条结果`
  }
  if (name === 'assess_flood_risk') {
    const level = content?.risk_level ?? content?.risk_label ?? payload?.risk_level ?? payload?.risk_label
    if (level) return `${level}级风险`
  }
  if (name === 'generate_report' && content?.title) return truncateText(content.title, 42)
  if (name === 'match_emergency_response') {
    const count = countFrom(content?.matched_plans)
    if (count != null) return `${count} 个匹配方案`
  }
  const summary = payload?.summary || content?.summary || content?.message || payload?.message
  return typeof summary === 'string' ? truncateText(summary, 42) : ''
}

export function getToolInspectorMeta(node) {
  const { args, content, metadata, payload } = parseToolPayload(node)
  return buildToolMeta(node, args, content, metadata, payload)
}

export function getToolSummarySections(node) {
  const { args, content, metadata, payload } = parseToolPayload(node)
  return buildToolSummarySections(node, args, content, metadata, payload)
}

export function getToolInputSections(node) {
  const { args } = parseToolPayload(node)
  return buildToolInputSections(node, args)
}

export function getToolOutputSections(node) {
  const { args, content, metadata, payload } = parseToolPayload(node)
  return buildToolOutputSections(node, args, content, metadata, payload)
}

export function hasToolArguments(node) {
  return Object.keys(parseToolPayload(node).args).length > 0
}

export function formatToolContent(value, maxLength = 1600) {
  return formatContent(value, maxLength)
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

  if (FILE_TOOLS.includes(name)) {
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

  if (FILE_TOOLS.includes(name)) {
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

function previewCallAgent(node, args, content, running) {
  const calledAgent = node.linkedAgentCall?.agent_display_name || args.agent_name || content?.metadata?.agent_name || ''
  const task = pickString(args.task, args.description, content?.summary)
  const lead = calledAgent ? `${running ? '调用中' : '调用'} ${shortName(calledAgent)}` : (running ? '调用中' : '调用子 Agent')
  return joinParts([lead, truncateText(task, 36)])
}

function previewUserInput(args, metadata, running) {
  const prompt = pickString(args.prompt)
  if (running) return prompt ? `等待输入: ${truncateText(prompt, 42)}` : '等待用户输入'
  if (metadata.degraded) return '未等待输入'
  const inputType = args.input_type === 'select' ? '选择' : '输入'
  return `已收到${inputType}`
}

function previewBash(args, content, metadata, running) {
  const command = pickString(args.description, args.command, metadata.command)
  if (running) return command ? `运行: ${truncateText(command, 50)}` : '运行命令'

  const backgroundId = pickString(content?.background_task_id, metadata.background_task_id)
  if (content?.background_started || metadata.background_started) {
    return joinParts(['后台任务已启动', backgroundId])
  }

  const code = firstNumber(content?.return_code, content?.exit_code, metadata.return_code, metadata.exit_code)
  const stdout = firstLine(content?.stdout)
  const stderr = firstLine(content?.stderr)
  if (code != null) {
    const lead = code === 0 ? '执行成功' : `退出码 ${code}`
    return joinParts([lead, truncateText(stdout || stderr, 34)])
  }

  return truncateText(pickString(content?.summary, metadata.summary), 42)
}

function previewCode(args, content, metadata, running) {
  const intent = pickString(args.description, firstLine(args.code))
  if (running) return intent ? `运行代码: ${truncateText(intent, 46)}` : '运行代码'

  const stdout = firstLine(metadata.stdout)
  const toolCalls = firstNumber(metadata.tool_calls_count, content?.tool_calls_count)
  const output = stdout || firstLine(typeof content === 'string' ? content : content?.result)
  const suffix = toolCalls ? `调用 ${toolCalls} 个工具` : output
  return joinParts(['执行成功', truncateText(suffix, 34)])
}

function previewFileTool(name, args, content, metadata, running) {
  const path = compactPath(pickString(
    content?.display_path,
    metadata.display_path,
    content?.file_path,
    metadata.file_path,
    args.file_path,
    args.path
  ), 34)

  if (running) {
    const action = { read_file: '读取', write_file: '写入', edit_file: '编辑', preview_data_structure: '预览' }[name] || '处理'
    return path ? `${action} ${path}` : `${action}文件`
  }

  if (name === 'read_file') {
    const start = firstNumber(metadata.start_line)
    const end = firstNumber(metadata.end_line)
    const total = firstNumber(metadata.total_lines)
    const lines = start != null && end != null
      ? `${start}-${end}${total != null ? `/${total}` : ''} 行`
      : `${countTextLines(content)} 行`
    return joinParts([path ? `读取 ${path}` : '读取文件', lines])
  }

  if (name === 'write_file') {
    const size = firstNumber(content?.file_size, metadata.file_size)
    return joinParts([path ? `写入 ${path}` : '写入文件', formatBytes(size)])
  }

  if (name === 'edit_file') {
    const replacements = firstNumber(content?.replacements, metadata.replacements)
    return joinParts([path ? `编辑 ${path}` : '编辑文件', replacements != null ? `替换 ${replacements} 处` : ''])
  }

  const shape = previewDataShape(content)
  return joinParts([path ? `预览 ${path}` : '预览数据', shape])
}

function previewSearchTool(name, args, content, running) {
  const pattern = pickString(args.pattern, args.query, args.glob)
  const path = compactPath(pickString(args.path), 34)
  if (running) {
    const action = name === 'glob' ? '匹配' : '搜索'
    return joinParts([pattern ? `${action} ${quoteShort(pattern)}` : action, path])
  }

  if (name === 'glob') {
    const count = firstNumber(content?.numFiles, countFrom(content?.filenames))
    return joinParts([pattern ? `匹配 ${quoteShort(pattern)}` : '匹配文件', count != null ? `${count} 个文件` : ''])
  }

  const count = firstNumber(content?.count, countFrom(content?.matches))
  const label = args.output_mode === 'files_with_matches' ? '个文件' : '条结果'
  return joinParts([pattern ? `搜索 ${quoteShort(pattern)}` : '搜索内容', count != null ? `${count} ${label}` : ''])
}

function previewWebFetch(args, content, running) {
  const url = pickString(content?.url, args.url)
  const target = url ? compactUrl(url) : ''
  if (running) return target ? `获取 ${target}` : '获取网页'
  const total = firstNumber(content?.total_length)
  const range = total != null ? `${formatCount(total)} 字符` : ''
  const truncated = content?.truncated ? '已截断' : ''
  return joinParts([target ? `获取 ${target}` : '获取网页', range, truncated])
}

function previewSkillTool(name, args, content, metadata, running) {
  const skill = pickString(args.skill_name, content?.skill, content?.skill_name, metadata.skill, metadata.skill_name)
  const script = pickString(args.script_name, content?.script_name, metadata.script_name)
  const resource = pickString(args.resource_file, content?.file_name)
  if (running) {
    if (name === 'execute_skill_script') return joinParts([skill ? `执行 ${skill}` : '执行 Skill 脚本', script])
    if (name === 'load_skill_resource') return joinParts([skill ? `加载 ${skill}` : '加载 Skill 资源', resource])
    if (name === 'get_skill_info') return skill ? `查询 ${skill}` : '查询 Skill 信息'
    return skill ? `激活 ${skill}` : '激活 Skill'
  }

  if (content?.background_started || metadata.background_started) {
    return joinParts(['后台脚本已启动', script || skill])
  }
  if (content?.artifact_id || metadata.artifact_id) {
    return joinParts(['生成可视化', pickString(content?.title, content?.artifact_id, metadata.artifact_id)])
  }
  if (content?.team_name || metadata.team_name) {
    return `应用团队 ${pickString(content?.team_name, metadata.team_name)}`
  }
  if (name === 'execute_skill_script') {
    const code = firstNumber(content?.return_code)
    return joinParts([skill ? `${skill}/${script || '脚本'}` : (script || 'Skill 脚本'), code != null ? `返回码 ${code}` : '执行完成'])
  }
  if (name === 'load_skill_resource') {
    const length = firstNumber(metadata.length, content?.content?.length)
    return joinParts([resource ? `加载 ${resource}` : '加载资源', length != null ? `${formatCount(length)} 字符` : ''])
  }
  if (name === 'get_skill_info') {
    const scriptLabel = content?.has_scripts === true ? '含脚本' : (content?.has_scripts === false ? '无脚本' : '')
    return joinParts([skill ? `Skill ${skill}` : 'Skill 信息', scriptLabel])
  }
  const length = firstNumber(metadata.content_length)
  return joinParts([skill ? `已激活 ${skill}` : '已激活 Skill', length != null ? `${formatCount(length)} 字符` : ''])
}

function previewTaskTool(name, args, content, metadata, running) {
  if (name === 'todo_write') {
    const total = firstNumber(metadata.count, countFrom(content?.new_todos), countFrom(args.todos))
    if (running) return total != null ? `更新 ${total} 个待办` : '更新待办'
    const inProgress = firstNumber(metadata.in_progress)
    const completed = firstNumber(metadata.completed)
    return joinParts([total != null ? `待办 ${total} 项` : '待办已更新', inProgress != null ? `进行中 ${inProgress}` : '', completed != null ? `完成 ${completed}` : ''])
  }

  const task = content?.task || {}
  const taskId = pickString(args.task_id, task.id, content?.task_id, metadata.task_id)
  const subject = pickString(args.subject, task.subject)
  if (running) {
    const verb = {
      task_create: '创建任务',
      task_get: '读取任务',
      task_update: '更新任务',
      task_output: '读取后台任务',
      task_stop: '停止后台任务',
      task_list: '列出任务',
    }[name] || '处理任务'
    return joinParts([taskId ? `${verb} #${taskId}` : verb, truncateText(subject, 34)])
  }

  if (name === 'task_list') {
    const total = firstNumber(content?.total, content?.items?.length, metadata.total)
    return total != null ? `任务列表 ${total} 项` : '任务列表已更新'
  }
  if (name === 'task_update') {
    const status = pickString(args.status, content?.status_change?.to, task.status, metadata.status)
    return joinParts([taskId ? `任务 #${taskId}` : '任务已更新', statusLabel(status)])
  }
  if (name === 'task_output') {
    const status = pickString(content?.status, metadata.status)
    return joinParts([taskId ? `后台任务 ${taskId}` : '后台任务输出', statusLabel(status)])
  }
  if (name === 'task_stop') return taskId ? `已停止后台任务 ${taskId}` : '已停止后台任务'

  const status = pickString(task.status, metadata.status)
  return joinParts([taskId ? `任务 #${taskId}` : '任务', truncateText(subject, 34), statusLabel(status)])
}

function previewMemoryTool(name, args, content, metadata, running) {
  const memoryName = pickString(args.name, args.file_name, content?.file_name, content?.name, metadata.file_name)
  if (running) {
    if (name.startsWith('read')) return memoryName ? `读取记忆 ${memoryName}` : '读取记忆'
    if (name.startsWith('write')) return memoryName ? `写入记忆 ${memoryName}` : '写入记忆'
    if (name.startsWith('archive')) return memoryName ? `归档记忆 ${memoryName}` : '归档记忆'
    return '查询记忆'
  }
  const count = firstNumber(content?.count, content?.items?.length, metadata.count)
  return joinParts([memoryName ? `记忆 ${memoryName}` : '记忆', count != null ? `${count} 项` : '已完成'])
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

function pushMeta(target, label, value) {
  const text = normalizeDisplayValue(value)
  if (!text) return
  target.push({ label, value: text })
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

function toPreviewText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function firstLine(value) {
  const text = stripToolHeader(toPreviewText(value))
  if (!text) return ''
  return text.split(/\r?\n/).map(line => line.trim()).find(Boolean) || ''
}

function stripToolHeader(value) {
  return String(value || '').replace(/^\[[^\]]+\]\s*/, '').trim()
}

function joinParts(parts) {
  return parts.map(part => String(part || '').trim()).filter(Boolean).join(' · ')
}

function countFrom(value) {
  if (Array.isArray(value)) return value.length
  const number = firstNumber(value)
  return number == null ? null : number
}

function countTextLines(value) {
  if (typeof value !== 'string' || !value) return 0
  return value.split(/\r?\n/).length
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

function quoteShort(value) {
  const text = truncateText(value, 30)
  return text ? `"${text}"` : ''
}

function truncateText(value, max) {
  const text = String(value || '').trim()
  return text.length > max ? `${text.slice(0, max)}...` : text
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

function getErrorText(payload, preview) {
  const text = pickString(
    payload?.error,
    payload?.summary,
    payload?.message,
    payload?.content?.error,
    payload?.content?.message,
    payload?.content,
    preview
  )
  return firstLine(text)
}

function normalizeStatus(status) {
  if (status === 'completed' || status === 'success') return 'success'
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'cancelled' || status === 'stopped') return 'stopped'
  if (status === 'running') return 'running'
  return status || 'pending'
}

function shortName(name) {
  if (!name) return ''
  return String(name).replace(/_agent$/i, '').replace(/_/g, ' ')
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
