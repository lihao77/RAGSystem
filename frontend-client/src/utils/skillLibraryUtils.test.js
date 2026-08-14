import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeBase64Text, decodeBase64Text, decodeBase64Bytes } from './base64.js';
import { isEditableTextFile, isValidRelativePath, guessMediaType, formatSize } from './skillFiles.js';
import { flattenFileTree, togglePathInSet } from './fileTree.js';
import { draftStatusLabel, draftStatusVariant, draftOrigin, sourceLabel } from './skillPresentation.js';

test('base64 text round-trips including CJK and emoji', () => {
  const source = '# 标题\n中文内容 🎉 with ascii';
  assert.equal(decodeBase64Text(encodeBase64Text(source)), source);
});

test('decodeBase64Bytes returns raw bytes', () => {
  assert.deepEqual(Array.from(decodeBase64Bytes(encodeBase64Text('ab'))), [97, 98]);
});

test('isEditableTextFile accepts text media and known extensions, rejects large/binary', () => {
  assert.equal(isEditableTextFile({ size: 10, media_type: 'text/markdown', relative_path: 'a.md' }), true);
  assert.equal(isEditableTextFile({ size: 10, media_type: 'application/json', relative_path: 'a.bin' }), true);
  assert.equal(isEditableTextFile({ size: 10, media_type: 'application/octet-stream', relative_path: 'script.py' }), true);
  assert.equal(isEditableTextFile({ size: 10, media_type: 'application/octet-stream', relative_path: 'a.bin' }), false);
  assert.equal(isEditableTextFile({ size: 3 * 1024 * 1024, media_type: 'text/plain', relative_path: 'big.md' }), false);
  assert.equal(isEditableTextFile(null), false);
});

test('isValidRelativePath rejects absolute/traversal/empty segments', () => {
  assert.equal(isValidRelativePath('scripts/check.py'), true);
  assert.equal(isValidRelativePath('a\\b.md'), true);
  assert.equal(isValidRelativePath('/abs.md'), false);
  assert.equal(isValidRelativePath('C:/x.md'), false);
  assert.equal(isValidRelativePath('../up.md'), false);
  assert.equal(isValidRelativePath('a//b.md'), false);
  assert.equal(isValidRelativePath(''), false);
});

test('guessMediaType maps known extensions and defaults to plain text', () => {
  assert.equal(guessMediaType('a.md'), 'text/markdown; charset=utf-8');
  assert.equal(guessMediaType('a.PY'), 'text/x-python; charset=utf-8');
  assert.equal(guessMediaType('a.unknownext'), 'text/plain; charset=utf-8');
});

test('formatSize formats B/KB/MB', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatSize(undefined), '0 B');
});

test('flattenFileTree builds sorted tree with directories first and honors collapsed set', () => {
  const nodes = flattenFileTree([
    { path: 'scripts/tool.py', type: 'file', size: 10 },
    { path: 'SKILL.md', type: 'file', size: 20 },
    { path: 'scripts/lib/util.py', type: 'file', size: 5 },
  ], new Set());
  assert.deepEqual(nodes.map((n) => n.path), ['scripts', 'scripts/lib', 'scripts/lib/util.py', 'scripts/tool.py', 'SKILL.md']);
  const collapsed = flattenFileTree([
    { path: 'scripts/tool.py', type: 'file' },
    { path: 'SKILL.md', type: 'file' },
  ], new Set(['scripts']));
  assert.deepEqual(collapsed.map((n) => `${n.path}:${n.collapsed ? 'closed' : 'open'}`), ['scripts:closed', 'SKILL.md:open']);
});

test('togglePathInSet toggles immutably', () => {
  const base = new Set(['a']);
  const next = togglePathInSet(base, 'a');
  const added = togglePathInSet(base, 'b');
  assert.equal(next.has('a'), false);
  assert.equal(added.has('b'), true);
  assert.equal(base.has('a'), true);
});

test('draft status label/variant cover missing/conflict/published/draft', () => {
  assert.equal(draftStatusLabel({ status: 'published', package_state: 'missing' }), '发布包缺失');
  assert.equal(draftStatusVariant({ status: 'published', package_state: 'conflict' }), 'destructive');
  assert.equal(draftStatusLabel({ status: 'published' }), '已发布');
  assert.equal(draftStatusVariant({ status: 'draft' }), 'warning');
});

test('draftOrigin and sourceLabel render fallbacks', () => {
  assert.equal(draftOrigin({ source_agent_name: 'builder' }), '由 builder 创建');
  assert.equal(draftOrigin({}), '管理员 Draft');
  assert.equal(sourceLabel('user_global'), '租户');
  assert.equal(sourceLabel('mystery'), '系统');
});
