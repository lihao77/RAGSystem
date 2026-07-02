import test from 'node:test';
import assert from 'node:assert/strict';

import { useToast } from './useToast.js';

const { state, show, hide, success, error, warning } = useToast();

// useToast 是模块单例,每个测试开头 hide() 清状态与待触发的隐藏定时器。
function reset() {
  hide();
}

test('show 写入 message/type 并打开 visible', () => {
  reset();
  show('hello', 'success');
  assert.equal(state.visible, true);
  assert.equal(state.message, 'hello');
  assert.equal(state.type, 'success');
  assert.equal(state.action, null);
});

test('show 第二参为函数时作为 action,默认 type=error', () => {
  reset();
  const fn = () => {};
  show('重试?', fn, '再来一次');
  assert.equal(state.action, fn);
  assert.equal(state.type, 'error');
  assert.equal(state.actionLabel, '再来一次');
});

test('success/error/warning 各自设置 type', () => {
  reset();
  success('ok');
  assert.equal(state.type, 'success');
  assert.equal(state.message, 'ok');

  error('boom');
  assert.equal(state.type, 'error');
  assert.equal(state.message, 'boom');

  warning('careful');
  assert.equal(state.type, 'warning');
  assert.equal(state.message, 'careful');
});

test('error 支持 action 回调', () => {
  reset();
  const retry = () => {};
  error('失败', retry);
  assert.equal(state.action, retry);
  assert.equal(state.type, 'error');
});

test('hide 关闭 visible', () => {
  reset();
  success('temp');
  assert.equal(state.visible, true);
  hide();
  assert.equal(state.visible, false);
});
