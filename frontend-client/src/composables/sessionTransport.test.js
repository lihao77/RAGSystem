import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionTransport } from './sessionTransport.js';

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

test('SessionTransport preserves the durable cursor across reconnects and drops duplicate events', async () => {
  const sockets = [];
  const delivered = [];
  let currentSessionId = 'session-1';
  const transport = createSessionTransport({
    getCurrentSessionId: () => currentSessionId,
    issueTicket: async () => ({ data: { ticket: `ticket-${sockets.length + 1}` } }),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onEnvelope: (event) => delivered.push(event),
  });

  await transport.connect(currentSessionId);
  sockets[0].onmessage({ data: JSON.stringify({ type: 'stream_output', session_id: currentSessionId, seq: 4 }) });
  sockets[0].onmessage({ data: JSON.stringify({ type: 'stream_output', session_id: currentSessionId, seq: 4 }) });

  assert.equal(delivered.length, 1);
  assert.equal(transport.getLastEventSeq(currentSessionId), 4);

  transport.disconnect();
  await transport.connect(currentSessionId);
  assert.match(sockets[1].url, /after_seq=4/);

  transport.initializeSessionEventCursor(currentSessionId, 6);
  transport.disconnect();
  await transport.connect(currentSessionId);
  assert.match(sockets[2].url, /after_seq=6/);
});

test('SessionTransport sends an explicit zero watermark for an empty history snapshot', async () => {
  const sockets = [];
  const transport = createSessionTransport({
    getCurrentSessionId: () => 'session-empty',
    issueTicket: async () => ({ data: { ticket: 'ticket-empty' } }),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onEnvelope: () => {},
  });

  transport.initializeSessionEventCursor('session-empty', 0);
  await transport.connect('session-empty', { historySnapshot: true });

  assert.match(sockets[0].url, /after_seq=0/);
  assert.match(sockets[0].url, /history_snapshot=1/);
});

test('SessionTransport 在 active run 历史回放完成前断线时保留历史快照标记', async () => {
  const sockets = [];
  const timers = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  globalThis.clearTimeout = () => {};
  try {
    const transport = createSessionTransport({
      getCurrentSessionId: () => 'session-1',
      issueTicket: async () => ({ data: { ticket: `ticket-${sockets.length + 1}` } }),
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      onEnvelope: () => {},
      maxReconnectAttempts: 2,
    });

    transport.initializeSessionEventCursor('session-1', 10);
    await transport.connect('session-1', { historySnapshot: true });
    sockets[0].onopen();
    sockets[0].onclose();
    timers.shift()();
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(sockets[1].url, /after_seq=10/);
    assert.match(sockets[1].url, /history_snapshot=1/);
    sockets[1].onmessage({ data: JSON.stringify({
      type: 'session.reconnect',
      session_id: 'session-1',
      payload: { phase: 'end', replay_count: 2, replay_source: 'active_run_snapshot' },
    }) });
    sockets[1].onclose();
    timers.shift()();
    await new Promise((resolve) => setImmediate(resolve));

    assert.doesNotMatch(sockets[2].url, /history_snapshot=1/);
    assert.match(sockets[2].url, /after_seq=10/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('SessionTransport 可强制重连并请求 active run 历史快照', async () => {
  const sockets = [];
  const transport = createSessionTransport({
    getCurrentSessionId: () => 'session-1',
    issueTicket: async () => ({ data: { ticket: `ticket-${sockets.length + 1}` } }),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onEnvelope: () => {},
  });

  transport.initializeSessionEventCursor('session-1', 17);
  await transport.connect('session-1');
  await transport.reconnect('session-1', { historySnapshot: true });

  assert.equal(sockets.length, 2);
  assert.match(sockets[1].url, /after_seq=17/);
  assert.match(sockets[1].url, /history_snapshot=1/);
});

test('SessionTransport discards a ticket issued for a session that is no longer current', async () => {
  const sockets = [];
  const pending = new Map();
  let currentSessionId = 'session-1';
  const transport = createSessionTransport({
    getCurrentSessionId: () => currentSessionId,
    issueTicket: (sessionId) => new Promise((resolve) => pending.set(sessionId, resolve)),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onEnvelope: () => {},
  });

  const first = transport.connect('session-1');
  currentSessionId = 'session-2';
  const second = transport.connect('session-2');
  pending.get('session-2')({ data: { ticket: 'ticket-2' } });
  await second;
  pending.get('session-1')({ data: { ticket: 'ticket-1' } });
  await first;

  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /session-2/);
});

test('SessionTransport keeps the reconnect budget when a socket opens then immediately closes', async () => {
  const sockets = [];
  const timers = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let exhausted = 0;
  globalThis.setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  globalThis.clearTimeout = () => {};
  try {
    const transport = createSessionTransport({
      getCurrentSessionId: () => 'session-1',
      issueTicket: async () => ({ data: { ticket: `ticket-${sockets.length + 1}` } }),
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      onEnvelope: () => {},
      onReconnectExhausted: () => { exhausted += 1; },
      maxReconnectAttempts: 2,
    });

    await transport.connect('session-1');
    sockets[0].onopen();
    sockets[0].onclose();
    timers.shift()();
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(sockets[1].url, /after_seq=0/);
    sockets[1].onopen();
    sockets[1].onclose();
    timers.shift()();
    await new Promise((resolve) => setImmediate(resolve));

    sockets[2].onopen();
    sockets[2].onclose();
    assert.equal(exhausted, 1);
    assert.equal(timers.length, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
