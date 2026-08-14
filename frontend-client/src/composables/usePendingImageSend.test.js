import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pendingImageSendState,
  pendingImagePhase,
  pendingImageThumbStates,
  capturePendingImageSend,
  clearPendingImageSend,
} from './usePendingImageSend.js';
import {
  handlePluginEventPayload,
  resetPluginEventsState,
} from './usePluginEvents.js';

const IMAGE_PLUGIN = '@ragsystem/backend-plugin-image-tools';

const imageEvent = (event, data = {}) => ({
  plugin_id: IMAGE_PLUGIN,
  event,
  data,
  delivery: 'ephemeral',
});

const localImage = (name = 'a.png') => ({
  source: 'local',
  local_id: `local-test-${name}`,
  file: new File(['fake-bytes'], name, { type: 'image/png' }),
  original_name: name,
  mime: 'image/png',
  kind: 'image',
  preview_url: '',
});

test.beforeEach(() => {
  clearPendingImageSend();
  resetPluginEventsState();
});

test('无图片附件时不捕获（纯文本/文件附件消息）', () => {
  assert.equal(capturePendingImageSend({ content: 'hi', attachments: [] }), false);
  assert.equal(capturePendingImageSend({
    content: 'hi',
    attachments: [{ source: 'session', file_id: 'f1', mime: 'application/pdf', kind: 'file' }],
  }), false);
  assert.equal(pendingImageSendState.active, false);
});

test('本地图片附件捕获：新建自有 object URL，文本与阶段初始为 sending', t => {
  const created = [];
  t.mock.method(URL, 'createObjectURL', () => `blob:mock-${created.length}`);
  // createObjectURL 在捕获路径被调用（原 preview_url 不复用——materialize 会 revoke 它）
  const captured = capturePendingImageSend({ content: '  看看这两张图  ', attachments: [localImage('a.png'), localImage('b.png')] });

  assert.equal(captured, true);
  assert.equal(pendingImageSendState.active, true);
  assert.equal(pendingImageSendState.text, '  看看这两张图  ');
  assert.equal(pendingImageSendState.thumbs.length, 2);
  assert.equal(pendingImageSendState.thumbs[0].owned, true);
  assert.equal(pendingImageSendState.thumbs[0].url, 'blob:mock-0');
  assert.equal(pendingImagePhase.value, 'sending');
});

test('清理时释放自有 object URL 并重置状态', t => {
  const revoked = [];
  t.mock.method(URL, 'createObjectURL', () => `blob:mock-${revoked.length}`);
  t.mock.method(URL, 'revokeObjectURL', url => { revoked.push(url); });
  capturePendingImageSend({ content: '', attachments: [localImage()] });

  clearPendingImageSend();

  assert.deepEqual(revoked, ['blob:mock-0']);
  assert.equal(pendingImageSendState.active, false);
  assert.equal(pendingImageSendState.thumbs.length, 0);
});

test('会话文件附件走认证下载 URL（非自有，不释放）', t => {
  const revoked = [];
  t.mock.method(URL, 'revokeObjectURL', url => { revoked.push(url); });
  const captured = capturePendingImageSend({
    content: '',
    attachments: [{ source: 'session', file_id: 'f1', original_name: 'shot.png', mime: 'image/png', kind: 'image' }],
    getAttachmentPreviewUrl: attachment => `/api/agent/sessions/s1/files/${attachment.file_id}/download`,
  });

  assert.equal(captured, true);
  assert.equal(pendingImageSendState.thumbs[0].url, '/api/agent/sessions/s1/files/f1/download');
  assert.equal(pendingImageSendState.thumbs[0].owned, false);

  clearPendingImageSend();
  assert.deepEqual(revoked, []);
});

test('识别事件驱动阶段流转：sending → recognizing → done', () => {
  capturePendingImageSend({ content: '', attachments: [localImage()] });
  assert.equal(pendingImagePhase.value, 'sending');

  handlePluginEventPayload(imageEvent('image.describe_started', { source: 'message', total: 1 }));
  assert.equal(pendingImagePhase.value, 'recognizing');

  handlePluginEventPayload(imageEvent('image.describe_completed', { source: 'message', total: 1, described: 1, failed: 0 }));
  assert.equal(pendingImagePhase.value, 'done');

  // 落库清理后回到 sending（快照已不存在）
  clearPendingImageSend();
  assert.equal(pendingImagePhase.value, 'sending');
});

test('捕获前的旧 completed 结果不触发 done 误判', () => {
  // 上一轮识别已完成（lastOutcome 残留），新一轮快照不应立即判 done
  handlePluginEventPayload(imageEvent('image.describe_started', { source: 'message', total: 1 }));
  handlePluginEventPayload(imageEvent('image.describe_completed', { source: 'message', total: 1, described: 1, failed: 0 }));

  capturePendingImageSend({ content: '', attachments: [localImage()] });
  assert.equal(pendingImagePhase.value, 'sending');
});

test('逐张缩略图状态按 progress 事件 index 对齐', () => {
  capturePendingImageSend({ content: '', attachments: [localImage('a.png'), localImage('b.png'), localImage('c.png')] });
  assert.deepEqual(pendingImageThumbStates.value, ['pending', 'pending', 'pending']);

  handlePluginEventPayload(imageEvent('image.describe_started', { source: 'message', total: 3 }));
  handlePluginEventPayload(imageEvent('image.describe_progress', { source: 'message', index: 1, total: 3, ok: true }));
  handlePluginEventPayload(imageEvent('image.describe_progress', { source: 'message', index: 0, total: 3, ok: false }));

  assert.deepEqual(pendingImageThumbStates.value, ['failed', 'ok', 'pending']);
});

test('重复捕获先释放上一次快照的 object URLs', t => {
  const revoked = [];
  let created = 0;
  t.mock.method(URL, 'createObjectURL', () => `blob:mock-${created++}`);
  t.mock.method(URL, 'revokeObjectURL', url => { revoked.push(url); });

  capturePendingImageSend({ content: '第一条', attachments: [localImage('a.png')] });
  capturePendingImageSend({ content: '第二条', attachments: [localImage('b.png')] });

  assert.deepEqual(revoked, ['blob:mock-0']);
  assert.equal(pendingImageSendState.text, '第二条');
  assert.equal(pendingImageSendState.thumbs[0].url, 'blob:mock-1');
});

test('快照兜底超时自动清除', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  capturePendingImageSend({ content: '', attachments: [localImage()] });
  assert.equal(pendingImageSendState.active, true);

  t.mock.timers.tick(90_000);
  assert.equal(pendingImageSendState.active, false);
});
