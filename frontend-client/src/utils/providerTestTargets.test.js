import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getProviderTestTargets,
  providerTestTaskLabel,
  summarizeProviderTestResult,
} from './providerTestTargets.js';

// 模型即测试单元：每个已配置模型一个 chat 目标（运行参数取自模型条目）。
test('每个已配置模型生成一个 chat 测试目标', () => {
  const targets = getProviderTestTargets({
    models: [
      { name: 'gpt-4o', temperature: 0.2 },
      { name: 'gpt-4o-mini', supports_vision: true },
      { name: '  ' },
    ],
  });
  assert.deepEqual(targets.map(({ task, model }) => ({ task, model })), [
    { task: 'chat', model: 'gpt-4o' },
    { task: 'chat', model: 'gpt-4o-mini' },
  ]);
  assert.equal(providerTestTaskLabel('chat'), 'Chat');
});

test('未配置模型时无测试目标', () => {
  assert.deepEqual(getProviderTestTargets({}), []);
  assert.deepEqual(getProviderTestTargets({ models: [] }), []);
  assert.deepEqual(getProviderTestTargets({ models: [{ name: '' }] }), []);
});

test('chat 结果摘要截断响应内容并附时延', () => {
  assert.equal(
    summarizeProviderTestResult({ task: 'chat' }, { content: 'pong', latency: 0.125 }),
    '响应：pong · 0.13s',
  );
  assert.equal(
    summarizeProviderTestResult({ task: 'chat' }, {}),
    '响应：调用成功',
  );
});
