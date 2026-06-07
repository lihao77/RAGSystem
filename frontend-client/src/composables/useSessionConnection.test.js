import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

import { createActiveRunState } from './useActiveRunState.js';
import { useSessionConnection } from './useSessionConnection.js';

class FakeWebSocket {
  static instances = [];
  static OPEN = 1;
  static CONNECTING = 0;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }

  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function createConnectionDeps(onMessage) {
  return {
    currentSessionId: ref('session-1'),
    messages: ref([]),
    isLoading: ref(false),
    isCompressing: ref(false),
    activeRun: createActiveRunState(),
    onMessage,
    onRunFinalized: () => {},
    resetApprovalState: () => {},
    loadSessionMessages: () => {},
    deleteMessageCache: () => {},
    clearLlmRetryState: () => {},
    cacheMessages: () => {},
    refreshSessionExecutionState: () => {},
    scrollToBottom: () => {},
  };
}

test('session connection 重连时使用已观察到的 event_seq durable cursor', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalLocation = globalThis.location;
  const received = [];
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { protocol: 'http:', host: 'localhost:5174' },
  });

  try {
    const connection = useSessionConnection(createConnectionDeps((event, sessionId) => {
      received.push([event.type, sessionId, event.event_seq || null]);
    }));

    connection.connectSessionWS('session-1');
    assert.equal(FakeWebSocket.instances[0].url, 'ws://localhost:5174/api/agent/sessions/session-1/ws');

    FakeWebSocket.instances[0].emit({ type: 'session.run_started', event_seq: 3 });
    assert.equal(connection.getLastEventSeq('session-1'), 3);
    assert.deepEqual(received, [['session.run_started', 'session-1', 3]]);

    connection.disconnectSessionWS();
    connection.connectSessionWS('session-1');
    assert.equal(
      FakeWebSocket.instances[1].url,
      'ws://localhost:5174/api/agent/sessions/session-1/ws?after_event_seq=3',
    );

    FakeWebSocket.instances[1].emit({ type: 'session.run_started', event_seq: 3 });
    FakeWebSocket.instances[1].emit({ type: 'output.chunk', event_seq: 4, data: { content: 'x' } });

    assert.equal(connection.getLastEventSeq('session-1'), 4);
    assert.deepEqual(received, [
      ['session.run_started', 'session-1', 3],
      ['output.chunk', 'session-1', 4],
    ]);
  } finally {
    globalThis.WebSocket = originalWebSocket;
    if (originalLocation === undefined) {
      delete globalThis.location;
    } else {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  }
});
