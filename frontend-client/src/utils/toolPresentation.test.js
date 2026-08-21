import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getToolDiffView,
  getToolDisplayName,
  getToolIconKind,
  getToolInputSections,
  getToolInspectorLabel,
  getToolOutputSections,
  getToolSubtitle,
  getToolTerminalView,
  parseDiffPreviewText,
} from './toolPresentation.js'

test('Goal tools use Goal-specific presentation instead of legacy task labels', () => {
  const node = {
    type: 'tool_call',
    tool_name: 'goal_create',
    status: 'running',
    arguments: JSON.stringify({
      objective: '完成 Goal 模式',
      success_criteria: ['测试通过'],
    }),
  }

  assert.equal(getToolDisplayName(node), '创建 Goal')
  assert.equal(getToolInspectorLabel('goal_create'), 'Goal 详情')
  assert.equal(getToolIconKind('goal_create'), 'task')
  assert.match(getToolSubtitle(node), /创建 Goal/)
  assert.deepEqual(getToolInputSections(node).map((section) => section.label), ['最终目标', '验收标准'])
})

test('Goal list preview reports the returned history count', () => {
  const node = {
    type: 'tool_call',
    tool_name: 'goal_list',
    status: 'completed',
    raw_result: JSON.stringify({ content: { goals: [{ id: 'one' }, { id: 'two' }] } }),
  }

  assert.equal(getToolSubtitle(node), 'Goal 历史 2 项')
})

test('execute_bash terminal view exposes command, streams and exit code', () => {
  const node = {
    type: 'tool_call',
    tool_name: 'execute_bash',
    status: 'completed',
    arguments: JSON.stringify({
      command: 'python -m pytest',
      description: '跑测试',
      working_dir: 'D:/python/ragsystem',
    }),
    raw_result: JSON.stringify({
      content: { stdout: '3 passed', stderr: '', return_code: 0 },
      metadata: { working_dir: 'D:/python/ragsystem' },
    }),
  }

  const view = getToolTerminalView(node)
  assert.equal(view.command, 'python -m pytest')
  assert.equal(view.description, '跑测试')
  assert.equal(view.stdout, '3 passed')
  assert.equal(view.stderr, '')
  assert.equal(view.exitCode, 0)
  assert.equal(getToolTerminalView({ type: 'tool_call', tool_name: 'edit_file' }), null)
})

test('parseDiffPreviewText parses backend diff preview into a line model', () => {
  const parsed = parseDiffPreviewText([
    '--- a/toolPresentation.js',
    '+++ b/toolPresentation.js',
    '@@ line 3 @@',
    '-const old = 1',
    '+const fresh = 2',
    '... [DIFF TRUNCATED]',
  ].join('\n'))

  assert.equal(parsed.fileName, 'toolPresentation.js')
  assert.equal(parsed.truncated, true)
  assert.deepEqual(parsed.lines.map((line) => line.type), ['hunk', 'removed', 'added'])
  assert.equal(parsed.lines[1].text, 'const old = 1')
  assert.equal(parsed.lines[1].lineNo, 3)
  assert.equal(parsed.lines[2].text, 'const fresh = 2')
  assert.equal(parsed.lines[2].lineNo, 3)
})

test('parseDiffPreviewText also tracks standard unified hunk headers', () => {
  const parsed = parseDiffPreviewText('@@ -12,3 +13,5 @@\n ctx\n-old\n+new\n+extra')

  assert.deepEqual(parsed.lines.map((line) => line.type), ['hunk', 'context', 'removed', 'added', 'added'])
  assert.equal(parsed.lines[2].lineNo, 13)
  assert.equal(parsed.lines[3].lineNo, 14)
  assert.equal(parsed.lines[4].lineNo, 15)
})

test('getToolDiffView builds the edit_file diff model with stats', () => {
  const node = {
    type: 'tool_call',
    tool_name: 'edit_file',
    status: 'completed',
    arguments: JSON.stringify({ file_path: 'src/utils/format.js', old_string: 'a', new_string: 'b' }),
    raw_result: JSON.stringify({
      content: {
        display_path: 'src/utils/format.js',
        replacements: 1,
        diff_preview: '--- a/format.js\n+++ b/format.js\n@@ line 7 @@\n-a\n+b',
      },
    }),
  }

  const view = getToolDiffView(node)
  assert.equal(view.fileName, 'format.js')
  assert.equal(view.filePath, 'src/utils/format.js')
  assert.equal(view.replacements, 1)
  assert.equal(view.added, 1)
  assert.equal(view.removed, 1)
  assert.deepEqual(view.lines.map((line) => line.type), ['hunk', 'removed', 'added'])
  assert.equal(getToolDiffView({ type: 'tool_call', tool_name: 'execute_bash' }), null)
})

test('code sections carry language hints for highlighting', () => {
  const bashNode = {
    type: 'tool_call',
    tool_name: 'execute_bash',
    arguments: JSON.stringify({ command: 'npm test' }),
  }
  const bashCommand = getToolInputSections(bashNode).find((section) => section.id === 'input-bash-command')
  assert.equal(bashCommand.language, 'bash')

  const readNode = {
    type: 'tool_call',
    tool_name: 'read_file',
    arguments: JSON.stringify({ file_path: 'src/app.py' }),
    raw_result: JSON.stringify({ content: 'print(1)' }),
  }
  const readContent = getToolOutputSections(readNode).find((section) => section.id === 'output-read-file')
  assert.equal(readContent.language, 'python')
})

test('terminal view recovers stdout/stderr from the rendered bash observation text', () => {
  const node = {
    type: 'tool_call',
    tool_name: 'execute_bash',
    status: 'success',
    arguments: JSON.stringify({ command: 'npm test', description: '跑测试' }),
    result_preview: '<tool_result id="t1" name="execute_bash" ok="true">命令执行完成，返回码 0\n3 passed\n1 failed\n[stderr]\nwidget overflow</tool_result>',
  }

  const view = getToolTerminalView(node)
  assert.equal(view.command, 'npm test')
  assert.equal(view.exitCode, 0)
  assert.equal(view.stdout, '3 passed\n1 failed')
  assert.equal(view.stderr, 'widget overflow')
})

test('terminal view parses failure observations where stderr precedes stdout', () => {
  const node = {
    type: 'tool_call',
    tool_name: 'execute_bash',
    status: 'success',
    arguments: JSON.stringify({ command: 'python bad.py' }),
    result_preview: '命令执行完成，返回码 1（stdout 已截断）\n[stderr]\nTraceback (most recent call last):\n  File "bad.py", line 3\n[stdout]\npartial output',
  }

  const view = getToolTerminalView(node)
  assert.equal(view.exitCode, 1)
  assert.equal(view.stderr, 'Traceback (most recent call last):\n  File "bad.py", line 3')
  assert.equal(view.stdout, 'partial output')
})

test('terminal view recognizes background task observations', () => {
  const node = {
    type: 'tool_call',
    tool_name: 'execute_bash',
    status: 'success',
    arguments: JSON.stringify({ command: 'npm run dev', run_in_background: true }),
    result_preview: '后台任务已启动\ntask_id: bash-123',
  }

  const view = getToolTerminalView(node)
  assert.equal(view.backgroundStarted, true)
  assert.equal(view.backgroundId, 'bash-123')
  assert.equal(view.exitCode, null)
})

test('tool payload recovers structured content from the observation json fence', () => {
  const diff = '--- a/format.js\n+++ b/format.js\n@@ line 7 @@\n-a\n+b'
  const node = {
    type: 'tool_call',
    tool_name: 'edit_file',
    status: 'success',
    arguments: JSON.stringify({ file_path: 'src/format.js', old_string: 'a', new_string: 'b' }),
    result_preview: `文件编辑成功: src/format.js（替换 1 处，10 字节）\n\n\`\`\`json\n${JSON.stringify({ display_path: 'src/format.js', replacements: 1, diff_preview: diff })}\n\`\`\``,
  }

  const view = getToolDiffView(node)
  assert.equal(view.filePath, 'src/format.js')
  assert.equal(view.replacements, 1)
  assert.equal(view.added, 1)
  assert.equal(view.removed, 1)
  assert.deepEqual(view.lines.map((line) => line.type), ['hunk', 'removed', 'added'])
})
