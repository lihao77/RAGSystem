import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getToolDisplayName,
  getToolIconKind,
  getToolInputSections,
  getToolInspectorLabel,
  getToolSubtitle,
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
