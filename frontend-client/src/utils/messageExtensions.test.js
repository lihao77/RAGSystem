import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRichContentPart,
  applyRichContentTextDelta,
  createAttachmentsExtension,
  getMessageAttachments,
  getMessageFileRefs,
  reconcileRichContent,
} from './messageExtensions.js';

test('createAttachmentsExtension 生成唯一 attachments@v1 权威快照', () => {
  const extension = createAttachmentsExtension([{
    file_id: 'file-1',
    original_name: 'hostMCP.png',
    stored_name: 'file-1_hostMCP.png',
    mime: 'image/png',
    size: 3,
    kind: 'image',
    stored_path: 'private/object-key',
  }]);

  assert.deepEqual(extension, {
    kind: 'attachments',
    version: 1,
    data: {
      items: [{
        file_id: 'file-1',
        original_name: 'hostMCP.png',
        stored_name: 'file-1_hostMCP.png',
        mime: 'image/png',
        size: 3,
        kind: 'image',
      }],
    },
  });
  assert.equal(JSON.stringify(extension).includes('stored_path'), false);
});

test('rich_content@v1 支持增量内容块并由 final 快照校准', () => {
  const message = { content: 'Map: ', metadata: {} };
  applyRichContentPart(message, 1, {
    type: 'file_ref',
    file_path: 'results/map.png',
    presentation: 'inline',
  });
  applyRichContentTextDelta(message, 2, ' done');

  assert.deepEqual(getMessageFileRefs(message), [{
    type: 'file_ref',
    file_path: 'results/map.png',
    presentation: 'inline',
  }]);

  reconcileRichContent(message, [
    { type: 'text', text: 'Final map: ' },
    { type: 'file_ref', file_path: 'results/final.png', presentation: 'preview' },
  ]);
  assert.deepEqual(getMessageFileRefs(message).map(part => part.file_path), ['results/final.png']);
});

test('getMessageAttachments 只读取 attachments@v1，不读取旧 metadata.attachments', () => {
  const metadata = {
    attachments: [{ file_id: 'legacy-file', original_name: 'legacy.txt' }],
    extensions: [{
      kind: 'attachments',
      version: 1,
      data: {
        items: [{
          file_id: 'file-1',
          original_name: 'note.txt',
          stored_name: 'file-1_note.txt',
          mime: 'text/plain',
          size: 12,
          kind: 'file',
        }],
      },
    }],
  };

  assert.deepEqual(getMessageAttachments(metadata), [{
    source: 'session',
    file_id: 'file-1',
    original_name: 'note.txt',
    stored_name: 'file-1_note.txt',
    mime: 'text/plain',
    size: 12,
    kind: 'file',
  }]);
  assert.deepEqual(getMessageAttachments({ attachments: metadata.attachments }), []);
});
