import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMessageContentPart,
  applyMessageContentTextDelta,
  createUserContentParts,
  getImageDescriptionMap,
  getMessageAttachments,
  getMessageCommandResult,
  getMessageFileRefs,
  getUserDisplayText,
  normalizeMessageContentParts,
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

test('image_description part 透传且校验必填字段', () => {
  const parts = normalizeMessageContentParts([
    { type: 'image_description', file_id: 'file-1', original_name: 'a.png', text: '描述内容' },
    { type: 'image_description', file_id: '', original_name: 'bad.png', text: '缺 file_id' },
    { type: 'text', text: '正文' },
  ]);
  assert.deepEqual(parts, [
    { type: 'image_description', file_id: 'file-1', original_name: 'a.png', text: '描述内容' },
    { type: 'text', text: '正文' },
  ]);
});

test('getUserDisplayText 排除图片描述 part 且回退聚合 content', () => {
  const message = {
    content_parts: [
      { type: 'text', text: '这是什么' },
      { type: 'attachment_ref', file_id: 'file-1', original_name: 'a.png', stored_name: 'f1', mime: 'image/png', size: 3, kind: 'image', presentation: 'inline' },
      { type: 'image_description', file_id: 'file-1', original_name: 'a.png', text: '一张风景照' },
    ],
  };
  assert.equal(getUserDisplayText(message), '这是什么');

  assert.equal(getUserDisplayText({ content: '仅 content 的消息', content_parts: [] }), '仅 content 的消息');
  assert.equal(getUserDisplayText({}), '');
});

test('getImageDescriptionMap 按紧跟 image attachment_ref 的结构化描述映射', () => {
  const message = {
    content_parts: [
      { type: 'text', text: '看图' },
      { type: 'attachment_ref', file_id: 'img-1', original_name: 'a.png', stored_name: 'f1', mime: 'image/png', size: 3, kind: 'image', presentation: 'inline' },
      { type: 'image_description', file_id: 'img-1', original_name: 'a.png', text: '描述一' },
      { type: 'attachment_ref', file_id: 'img-2', original_name: 'b.png', stored_name: 'f2', mime: 'image/png', size: 3, kind: 'image', presentation: 'inline' },
      { type: 'image_description', file_id: 'img-2', original_name: 'b.png', text: '描述二' },
    ],
  };
  assert.deepEqual(getImageDescriptionMap(message), {
    'img-1': '描述一',
    'img-2': '描述二',
  });
});

test('getImageDescriptionMap 忽略无描述/非图片附件/非紧跟的描述', () => {
  const message = {
    content_parts: [
      { type: 'attachment_ref', file_id: 'img-1', original_name: 'a.png', stored_name: 'f1', mime: 'image/png', size: 3, kind: 'image', presentation: 'inline' },
      { type: 'text', text: '没有描述' },
      { type: 'attachment_ref', file_id: 'doc-1', original_name: 'b.txt', stored_name: 'f2', mime: 'text/plain', size: 3, kind: 'file', presentation: 'attachment' },
      { type: 'image_description', file_id: 'doc-1', original_name: 'b.txt', text: '文件不适用' },
      { type: 'image_description', file_id: 'img-2', original_name: 'c.png', text: '没有前置附件' },
    ],
  };
  assert.deepEqual(getImageDescriptionMap(message), {});
});
