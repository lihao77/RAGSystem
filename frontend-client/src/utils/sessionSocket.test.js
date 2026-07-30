import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSessionSocketUrl,
  canReuseSessionSocket,
  getDurableCursorSeq,
  getDurableEventSeq,
  normalizeEventSeq,
} from './sessionSocket.js';

const OPEN = 1;
const CONNECTING = 0;
const CLOSED = 3;

test('会构造不带 durable cursor 的 session WebSocket URL', () => {
  assert.equal(
    buildSessionSocketUrl('session 1', { protocol: 'http:', host: 'localhost:5174' }),
    'ws://localhost:5174/api/agent/sessions/session%201/ws',
  );
});

test('已知 event_seq 时会构造 after_seq 重连 URL', () => {
  assert.equal(
    buildSessionSocketUrl('session-1', { protocol: 'https:', host: 'example.test', afterEventSeq: 12 }),
    'wss://example.test/api/agent/sessions/session-1/ws?after_seq=12',
  );
});

test('重连游标为零时仍会请求完整 durable replay', () => {
  assert.equal(
    buildSessionSocketUrl('session-1', { protocol: 'https:', host: 'example.test', afterEventSeq: 0 }),
    'wss://example.test/api/agent/sessions/session-1/ws?after_seq=0',
  );
});

test('历史快照首次连接会显式请求 active run 展示回放', () => {
  assert.equal(
    buildSessionSocketUrl('session-1', {
      protocol: 'https:',
      host: 'example.test',
      afterEventSeq: 12,
      historySnapshot: true,
    }),
    'wss://example.test/api/agent/sessions/session-1/ws?after_seq=12&history_snapshot=1',
  );
});

test('WebSocket URL 使用短时 ticket 而不是 session token', () => {
  assert.equal(
    buildSessionSocketUrl('session-1', { protocol: 'https:', host: 'example.test', afterEventSeq: 12, ticket: 'ticket-1' }),
    'wss://example.test/api/agent/sessions/session-1/ws?after_seq=12&ticket=ticket-1',
  );
});

test('仅接受正整数 event_seq 作为 durable cursor', () => {
  assert.equal(normalizeEventSeq(1), 1);
  assert.equal(normalizeEventSeq('2'), 2);
  assert.equal(normalizeEventSeq(0), null);
  assert.equal(normalizeEventSeq(-1), null);
  assert.equal(normalizeEventSeq(1.5), null);
  assert.equal(normalizeEventSeq('x'), null);
  assert.equal(getDurableEventSeq({ seq: 7 }), 7);
  assert.equal(getDurableEventSeq({ stream_seq: 7 }), null);
});

test('durable reconnect cursor 仅从 seq/cursor 或 heartbeat.payload 推进', () => {
  assert.equal(getDurableCursorSeq({ seq: 7 }), 7);
  assert.equal(getDurableCursorSeq({ type: 'heartbeat', payload: { last_seq: 9 } }), 9);
  assert.equal(getDurableCursorSeq({ type: 'heartbeat', payload: { last_seq: 0 } }), null);
  assert.equal(getDurableCursorSeq({ type: 'stream_output', payload: { last_seq: 10 } }), null);
  assert.equal(getDurableCursorSeq({ stream_seq: 11 }), null);
});

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
