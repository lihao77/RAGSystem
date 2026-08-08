import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMessageContentPart,
  applyMessageContentTextDelta,
  createUserContentParts,
  getMessageAttachments,
  getMessageCommandResult,
  getMessageFileRefs,
  reconcileMessageContentParts,
} from './messageContentParts.js';

test('createUserContentParts 生成用户文本和附件的唯一结构化快照', () => {
  const parts = createUserContentParts('查看图片', [{
    file_id: 'file-1',
    original_name: 'hostMCP.png',
    stored_name: 'file-1_hostMCP.png',
    mime: 'image/png',
    size: 3,
    kind: 'image',
    stored_path: 'private/object-key',
  }]);

  assert.deepEqual(parts, [
    { type: 'text', text: '查看图片' },
    {
      type: 'attachment_ref',
      file_id: 'file-1',
      original_name: 'hostMCP.png',
      stored_name: 'file-1_hostMCP.png',
      mime: 'image/png',
      size: 3,
      kind: 'image',
      presentation: 'inline',
    },
  ]);
  assert.equal(JSON.stringify(parts).includes('stored_path'), false);
});

test('content_parts 支持增量内容块并由 final 快照校准', () => {
  const message = { content: 'Map: ', content_parts: [] };
  applyMessageContentPart(message, 1, {
    type: 'file_ref',
    file_path: 'results/map.png',
    presentation: 'inline',
  });
  applyMessageContentTextDelta(message, 2, ' done');

  assert.deepEqual(getMessageFileRefs(message), [{
    type: 'file_ref',
    file_path: 'results/map.png',
    presentation: 'inline',
  }]);

  reconcileMessageContentParts(message, [
    { type: 'text', text: 'Final map: ' },
    { type: 'file_ref', file_path: 'results/final.png', presentation: 'preview' },
  ]);
  assert.deepEqual(getMessageFileRefs(message).map(part => part.file_path), ['results/final.png']);
});

test('getMessageAttachments 从 content_parts 派生附件视图', () => {
  const message = {
    content_parts: [{
      type: 'attachment_ref',
      file_id: 'file-1',
      original_name: 'note.txt',
      stored_name: 'file-1_note.txt',
      mime: 'text/plain',
      size: 12,
      kind: 'file',
      presentation: 'attachment',
    }],
  };

  assert.deepEqual(getMessageAttachments(message), [{
    source: 'session',
    file_id: 'file-1',
    original_name: 'note.txt',
    stored_name: 'file-1_note.txt',
    mime: 'text/plain',
    size: 12,
    kind: 'file',
  }]);
});

test('command parts 保留用户原文和系统结果语义', () => {
  const message = {
    content_parts: [{
      type: 'command_result',
      invocation_id: 'cmd-1',
      name: 'compact',
      success: true,
      text: '压缩完成',
    }],
  };

  assert.deepEqual(getMessageCommandResult(message), {
    type: 'command_result',
    invocation_id: 'cmd-1',
    name: 'compact',
    success: true,
    text: '压缩完成',
  });
});
