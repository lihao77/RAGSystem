import test from 'node:test';
import assert from 'node:assert/strict';

import { createLocalAttachment, getAttachmentKey, isLocalAttachment, normalizeSessionAttachment } from './sessionAttachments.js';

test('createLocalAttachment 为本地文件生成待发送附件模型', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:preview-local';
  URL.revokeObjectURL = () => {};

  class FakeFile extends File {
    constructor(parts, name, options) {
      super(parts, name, options);
    }
  }

  const file = new FakeFile(['img'], 'shot.png', { type: 'image/png' });
  const attachment = createLocalAttachment(file);

  assert.equal(isLocalAttachment(attachment), true);
  assert.equal(attachment.source, 'local');
  assert.equal(attachment.original_name, 'shot.png');
  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.preview_url, 'blob:preview-local');
  assert.match(attachment.local_id, /^local-/);
  assert.equal(getAttachmentKey(attachment), `local:${attachment.local_id}`);

  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

test('normalizeSessionAttachment 规范化后端会话附件引用', () => {
  const attachment = normalizeSessionAttachment({
    id: 'file-1',
    original_name: 'note.txt',
    mime: 'text/plain',
    size: 123,
  });

  assert.equal(attachment.source, 'session');
  assert.equal(attachment.file_id, 'file-1');
  assert.equal(attachment.kind, 'file');
  assert.equal(getAttachmentKey(attachment), 'session:file-1');
});
