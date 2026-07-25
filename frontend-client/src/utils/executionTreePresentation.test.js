import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActionRows,
  getToolGroupKey,
  TOOL_GROUP_MIN,
} from './executionTreePresentation.js';

const tool = (callId, toolName, status = 'success') => ({
  type: 'tool_call',
  call_id: callId,
  tool_name: toolName,
  status,
  arguments: {},
  result_preview: '',
  elapsed_time: 1,
});

const thought = (round) => ({ type: 'thought', round, intent: '想想', status: 'success' });

test('getToolGroupKey 只对 tool_call 返回分组键,且排除交互型工具', () => {
  assert.equal(getToolGroupKey(tool('a', 'read_file')), 'file');
  assert.equal(getToolGroupKey(tool('b', 'grep')), 'search');
  assert.equal(getToolGroupKey(tool('c', 'request_user_input')), null);
  assert.equal(getToolGroupKey(thought(0)), null);
  assert.equal(getToolGroupKey(null), null);
});

test('连续同类工具达到阈值折叠成组', () => {
  const nodes = [
    tool('1', 'read_file'),
    tool('2', 'write_file'),
    tool('3', 'edit_file'),
  ];
  const rows = buildActionRows(nodes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'group');
  assert.equal(rows[0].summary.count, 3);
  assert.equal(rows[0].summary.status, 'success');
  assert.equal(rows[0].summary.totalElapsed, 3);
});

test('不足阈值平铺,不分组', () => {
  const nodes = [tool('1', 'read_file'), tool('2', 'write_file')];
  const rows = buildActionRows(nodes);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.kind === 'node'));
});

test('非 tool 节点断开连续性', () => {
  const nodes = [
    tool('1', 'read_file'),
    tool('2', 'write_file'),
    thought(0),
    tool('3', 'read_file'),
    tool('4', 'write_file'),
    tool('5', 'edit_file'),
  ];
  const rows = buildActionRows(nodes);
  // 前 2 个 file 平铺 + thought + 后 3 个 file 成组
  assert.equal(rows.length, 4);
  assert.equal(rows[0].kind, 'node');
  assert.equal(rows[1].kind, 'node');
  assert.equal(rows[2].kind, 'node');
  assert.equal(rows[3].kind, 'group');
  assert.equal(rows[3].summary.count, 3);
});

test('不同类工具不相邻成组', () => {
  const nodes = [
    tool('1', 'read_file'),
    tool('2', 'write_file'),
    tool('3', 'grep'),
    tool('4', 'glob'),
    tool('5', 'grep'),
  ];
  const rows = buildActionRows(nodes);
  // file×2 平铺, search(grep/glob/grep 同为 search 类)连续 3 个成组
  const groups = rows.filter(r => r.kind === 'group');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].groupKey, 'search');
  assert.equal(groups[0].summary.count, 3);
});

test('组摘要反映 running/error 状态', () => {
  const nodes = [
    tool('1', 'grep', 'success'),
    tool('2', 'grep', 'running'),
    tool('3', 'grep', 'success'),
  ];
  const rows = buildActionRows(nodes);
  assert.equal(rows[0].summary.status, 'running');
  assert.equal(rows[0].summary.hasRunning, true);

  const errNodes = [
    tool('1', 'grep', 'success'),
    tool('2', 'grep', 'error'),
    tool('3', 'grep', 'running'),
  ];
  const errRows = buildActionRows(errNodes);
  assert.equal(errRows[0].summary.status, 'error');
  assert.equal(errRows[0].summary.hasError, true);
});

test('阈值常量与分组行为一致', () => {
  const nodes = Array.from({ length: TOOL_GROUP_MIN }, (_, i) => tool(String(i), 'grep'));
  const rows = buildActionRows(nodes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'group');
});
