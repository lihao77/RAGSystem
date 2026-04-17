import test from 'node:test';
import assert from 'node:assert/strict';

import { canReuseSessionSocket, shouldRefreshSessionMessagesAfterResume, shouldRunResumeRecoveryWatchdog } from './sessionSocket.js';

const OPEN = 1;
const CONNECTING = 0;
const CLOSED = 3;

test('会复用同一 session 的已连接 socket', () => {
  assert.equal(canReuseSessionSocket('session-1', 'session-1', { readyState: OPEN }), true);
});

test('会复用同一 session 的连接中 socket', () => {
  assert.equal(canReuseSessionSocket('session-1', 'session-1', { readyState: CONNECTING }), true);
});

test('切换到不同 session 时不会复用旧 socket', () => {
  assert.equal(canReuseSessionSocket('session-2', 'session-1', { readyState: OPEN }), false);
});

test('关闭的 socket 不会复用', () => {
  assert.equal(canReuseSessionSocket('session-1', 'session-1', { readyState: CLOSED }), false);
});

test('缺少必要参数时不会复用', () => {
  assert.equal(canReuseSessionSocket('', 'session-1', { readyState: OPEN }), false);
  assert.equal(canReuseSessionSocket('session-1', '', { readyState: OPEN }), false);
  assert.equal(canReuseSessionSocket('session-1', 'session-1', null), false);
});

test('后台仍在运行时不会强制刷新消息', () => {
  assert.equal(shouldRefreshSessionMessagesAfterResume({
    hasRunningTask: true,
    activeRun: true,
    messages: [{ role: 'assistant', finished: false }],
  }), false);
});

test('存在未完成 assistant 消息且后台已结束时会刷新消息', () => {
  assert.equal(shouldRefreshSessionMessagesAfterResume({
    hasRunningTask: false,
    activeRun: false,
    messages: [{ role: 'assistant', finished: false }],
  }), true);
});

test('最后停在用户消息且后台已结束时会刷新消息', () => {
  assert.equal(shouldRefreshSessionMessagesAfterResume({
    hasRunningTask: false,
    activeRun: false,
    messages: [
      { role: 'assistant', finished: true },
      { role: 'user', metadata: {}, finished: true },
    ],
  }), true);
});

test('后台已结束但前端仍有活跃 run 时会刷新消息', () => {
  assert.equal(shouldRefreshSessionMessagesAfterResume({
    hasRunningTask: false,
    activeRun: true,
    messages: [],
  }), true);
});

test('最后是已完成 assistant 消息时不刷新消息', () => {
  assert.equal(shouldRefreshSessionMessagesAfterResume({
    hasRunningTask: false,
    activeRun: false,
    messages: [
      { role: 'user', metadata: {}, finished: true },
      { role: 'assistant', finished: true },
    ],
  }), false);
});

test('运行中且不是系统命令时启用恢复 watchdog', () => {
  assert.equal(shouldRunResumeRecoveryWatchdog({
    hasRunningTask: true,
    hasActiveSystemCommand: false,
  }), true);
});

test('系统命令运行中时不启用恢复 watchdog', () => {
  assert.equal(shouldRunResumeRecoveryWatchdog({
    hasRunningTask: true,
    hasActiveSystemCommand: true,
  }), false);
});

test('后台未运行时不启用恢复 watchdog', () => {
  assert.equal(shouldRunResumeRecoveryWatchdog({
    hasRunningTask: false,
    hasActiveSystemCommand: false,
  }), false);
});
