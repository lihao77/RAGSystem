import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRestorableOverrides } from './modelAdapter.js';

const providers = [
  {
    key: 'ali_alibaba',
    name: 'ali',
    thinking: { kind: 'toggle', levels: ['off', 'on'] },
    models: [
      { name: 'deepseek-v4-flash', thinking_levels: ['high', 'max'] },
      { name: 'glm-5.2', thinking_levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
      {}, // 无名条目：不得被 "provider|" 两段值误命中
    ],
  },
];

test('无记录返回 null（存量会话不动全局默认）', () => {
  assert.equal(resolveRestorableOverrides(undefined, providers), null);
  assert.equal(resolveRestorableOverrides({}, providers), null);
  assert.equal(resolveRestorableOverrides({ _request_overrides: null }, providers), null);
  assert.equal(resolveRestorableOverrides({ _request_overrides: 'corrupt' }, providers), null);
});

test('有效记录恢复模型与档位（toggle+子集升级为 effort 分级）', () => {
  assert.deepEqual(
    resolveRestorableOverrides(
      { _request_overrides: { selected_llm: 'ali|alibaba|deepseek-v4-flash', thinking_level: 'high' } },
      providers,
    ),
    { selectedLLM: 'ali|alibaba|deepseek-v4-flash', thinkingLevel: 'high' },
  );
});

test('模型已下线 → 双项回落空串，不回显后端会拒收的值', () => {
  assert.deepEqual(
    resolveRestorableOverrides(
      { _request_overrides: { selected_llm: 'ali|alibaba|gone-model', thinking_level: 'high' } },
      providers,
    ),
    { selectedLLM: '', thinkingLevel: '' },
  );
});

test('档位超出模型值域 → 模型保留、档位回落空串', () => {
  assert.deepEqual(
    resolveRestorableOverrides(
      { _request_overrides: { selected_llm: 'ali|alibaba|deepseek-v4-flash', thinking_level: 'medium' } },
      providers,
    ),
    { selectedLLM: 'ali|alibaba|deepseek-v4-flash', thinkingLevel: '' },
  );
});

test('两段值/空模型名不误命中无名条目；非法类型与 null 字段安全回落', () => {
  assert.deepEqual(
    resolveRestorableOverrides({ _request_overrides: { selected_llm: 'ali|', thinking_level: 'high' } }, providers),
    { selectedLLM: '', thinkingLevel: '' },
  );
  assert.deepEqual(
    resolveRestorableOverrides({ _request_overrides: { selected_llm: null, thinking_level: null } }, providers),
    { selectedLLM: '', thinkingLevel: '' },
  );
  assert.deepEqual(
    resolveRestorableOverrides({ _request_overrides: { selected_llm: 123, thinking_level: ['high'] } }, providers),
    { selectedLLM: '', thinkingLevel: '' },
  );
});

test('providers 非数组按空处理', () => {
  assert.equal(resolveRestorableOverrides({}, undefined), null);
  assert.deepEqual(
    resolveRestorableOverrides(
      { _request_overrides: { selected_llm: 'ali|alibaba|deepseek-v4-flash' } },
      null,
    ),
    { selectedLLM: '', thinkingLevel: '' },
  );
});
