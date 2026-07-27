import test from 'node:test';
import assert from 'node:assert/strict';

import { serializeAttachmentForSend } from './sessionCommandController.js';

test('serializeAttachmentForSend 只向服务端提交 file_id', () => {
  assert.deepEqual(serializeAttachmentForSend({
    file_id: 'file-1',
    original_name: 'hostMCP.png',
    stored_name: 'file-1_hostMCP.png',
    stored_path: 'private/object-key',
    mime: 'image/png',
  }), { file_id: 'file-1' });
});
