import test from 'node:test';
import assert from 'node:assert/strict';

import { findMessageFileTarget } from './useMessageFiles.js';

function node(attributes) {
  return {
    getAttribute(name) {
      return attributes[name] ?? null;
    },
  };
}

function root(nodes) {
  return { querySelectorAll: () => nodes };
}

test('同一路径在多个消息中引用时按 messageKey 定位当前消息', () => {
  const first = node({ 'data-file-path': 'results/chart.png', 'data-message-key': 'seq:10' });
  const second = node({ 'data-file-path': 'results/chart.png', 'data-message-key': 'seq:20' });

  assert.equal(
    findMessageFileTarget(root([first, second]), {
      filePath: 'results/chart.png',
      messageKey: 'seq:20',
    }),
    second,
  );
});

test('没有消息作用域时才按路径选择第一个匹配项', () => {
  const first = node({ 'data-file-path': 'results/chart.png' });
  const second = node({ 'data-file-path': 'results/chart.png' });

  assert.equal(
    findMessageFileTarget(root([first, second]), { filePath: 'results/chart.png' }),
    first,
  );
});

test('有作用域但找不到对应消息时不误定位到其他消息', () => {
  const first = node({ 'data-file-path': 'results/chart.png', 'data-message-key': 'seq:10' });

  assert.equal(
    findMessageFileTarget(root([first]), {
      filePath: 'results/chart.png',
      messageKey: 'seq:20',
    }),
    null,
  );
});
