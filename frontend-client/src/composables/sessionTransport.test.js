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

  transport.resetSessionEventCursor(currentSessionId);
  transport.disconnect();
  await transport.connect(currentSessionId);
  assert.doesNotMatch(sockets[2].url, /after_seq=/);
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
