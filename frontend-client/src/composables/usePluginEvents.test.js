import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pluginEventState,
  imageDescribeActive,
  imageDescribeProgress,
  handlePluginEventPayload,
  resetPluginEventsState,
  IMAGE_DESCRIBE_STALE_MS,
} from './usePluginEvents.js';

const IMAGE_PLUGIN = '@ragsystem/backend-plugin-image-tools';

const imageEvent = (event, data = {}) => ({
  plugin_id: IMAGE_PLUGIN,
  event,
  data,
  delivery: 'ephemeral',
});

test.beforeEach(() => {
  resetPluginEventsState();
});

test('记录各插件最近一次事件（通用消费位）', () => {
  handlePluginEventPayload({ plugin_id: 'some-plugin', event: 'sync.done', data: { count: 3 } });

  const record = pluginEventState.latest.get('some-plugin:sync.done');
  assert.equal(record.plugin_id, 'some-plugin');
  assert.equal(record.data.count, 3);
  // 非 image-tools 事件不影响识别状态
  assert.equal(imageDescribeActive.value, false);
});

test('忽略缺 plugin_id 或 event 的畸形 payload', () => {
  handlePluginEventPayload({});
  handlePluginEventPayload({ plugin_id: 'x' });
  handlePluginEventPayload(null);

  assert.equal(pluginEventState.latest.size, 0);
});

test('describe started/progress/completed 驱动识别状态全生命周期', () => {
  handlePluginEventPayload(imageEvent('image.describe_started', { source: 'message', total: 3, files: ['a.png', 'b.png', 'c.png'] }));
  assert.equal(imageDescribeActive.value, true);
  assert.deepEqual(imageDescribeProgress.value, { done: 0, total: 3 });

  handlePluginEventPayload(imageEvent('image.describe_progress', { source: 'message', index: 0, total: 3, ok: true }));
  handlePluginEventPayload(imageEvent('image.describe_progress', { source: 'message', index: 1, total: 3, ok: false }));
  assert.deepEqual(imageDescribeProgress.value, { done: 2, total: 3 });
  assert.equal(pluginEventState.imageDescribe.failed, 1);

  handlePluginEventPayload(imageEvent('image.describe_completed', { source: 'message', total: 3, described: 2, failed: 1 }));
  assert.equal(imageDescribeActive.value, false);
  assert.equal(imageDescribeProgress.value, null);
  assert.deepEqual(pluginEventState.imageDescribe.lastOutcome, {
    total: 3,
    described: 2,
    failed: 1,
    at: pluginEventState.imageDescribe.lastOutcome.at,
  });
});

test('单图时不暴露进度计数（提示条只显示进行中文案）', () => {
  handlePluginEventPayload(imageEvent('image.describe_started', { source: 'view_image', total: 1 }));

  assert.equal(imageDescribeActive.value, true);
  assert.equal(imageDescribeProgress.value, null);
});

test('无 started 的迟到 progress 帧被忽略（断连漏帧）', () => {
  handlePluginEventPayload(imageEvent('image.describe_progress', { index: 0, total: 2, ok: true }));

  assert.equal(imageDescribeActive.value, false);
  assert.equal(pluginEventState.imageDescribe.done, 0);
});

test('并行描述操作按引用计数收尾（message 变换 + run 内 view_image）', () => {
  handlePluginEventPayload(imageEvent('image.describe_started', { source: 'message', total: 2 }));
  handlePluginEventPayload(imageEvent('image.describe_started', { source: 'view_image', total: 1 }));
  assert.equal(imageDescribeActive.value, true);

  // 其中一个完成：提示仍在
  handlePluginEventPayload(imageEvent('image.describe_completed', { source: 'view_image', total: 1, described: 1, failed: 0 }));
  assert.equal(imageDescribeActive.value, true);
  assert.deepEqual(imageDescribeProgress.value, { done: 0, total: 3 });

  handlePluginEventPayload(imageEvent('image.describe_completed', { source: 'message', total: 2, described: 2, failed: 0 }));
  assert.equal(imageDescribeActive.value, false);
});

test('completed 帧丢失时兜底超时收尾', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  handlePluginEventPayload(imageEvent('image.describe_started', { source: 'message', total: 1 }));
  assert.equal(imageDescribeActive.value, true);

  t.mock.timers.tick(IMAGE_DESCRIBE_STALE_MS);
  assert.equal(imageDescribeActive.value, false);
  // t.mock 在测试结束时自动恢复真实定时器
});

test('会话切换重置全部插件事件状态', () => {
  handlePluginEventPayload(imageEvent('image.describe_started', { source: 'message', total: 2 }));
  handlePluginEventPayload({ plugin_id: 'some-plugin', event: 'sync.done', data: {} });

  resetPluginEventsState();

  assert.equal(imageDescribeActive.value, false);
  assert.equal(pluginEventState.latest.size, 0);
  assert.equal(pluginEventState.imageDescribe.lastOutcome, null);
});
