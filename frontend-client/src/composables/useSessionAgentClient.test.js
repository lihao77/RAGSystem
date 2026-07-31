import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

import { useSessionAgentClient } from './useSessionAgentClient.js';
import { useSessionRunStore } from '../stores/session-run.js';

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
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function createConnectionDeps() {
  setActivePinia(createPinia());
  const sessionRunStore = useSessionRunStore();
  const { currentSessionId, messages, isLoading, isCompressing } = storeToRefs(sessionRunStore);
  currentSessionId.value = 'session-1';
  const noop = () => {};
  let ticketSequence = 0;
  return {
    currentSessionId,
    messages,
    isLoading,
    isCompressing,
    activeRun: sessionRunStore.activeRun,
    createAssistantMessage: () => ({
      role: 'assistant', content: '', status: [], executionTree: { root: null, steps: [] }, finished: false, metadata: {},
    }),
    cacheMessages: noop,
    deleteMessageCache: noop,
    loadSessionMessages: noop,
    mergeMessageIdsFromServer: noop,
    refreshSessionExecutionState: noop,
    mergeExecutionObservability: noop,
    updateRecentSession: noop,
    applyEnvelopeToMessage: noop,
    findRunningExecutionAgentByAgentId: () => null,
    isRootEvent: () => true,
    isMasterEvent: () => true,
    enqueueApproval: noop,
    handleApprovalResolved: noop,
    showUserInput: noop,
    resetApprovalState: noop,
    clearLlmRetryState: noop,
    setLlmRetryState: noop,
    checkSituationScreenTrigger: noop,
    handleStop: noop,
    scrollToBottom: noop,
    showToast: noop,
    issueSessionWsTicket: async () => ({ data: { ticket: `ticket-${++ticketSequence}` } }),
    userInputDialogRef: ref(null),
  };
}

function createSdkMock() {
  const listeners = new Map();
  const calls = { connect: [], disconnect: 0 };
  const sdk = {
    sessionId: null,
    on(type, listener) {
      const group = listeners.get(type) || new Set();
      group.add(listener);
      listeners.set(type, group);
      return () => group.delete(listener);
    },
    emit(type, payload) {
      for (const listener of listeners.get(type) || []) listener(payload);
    },
    async connect(sessionId, options) {
      sdk.sessionId = sessionId;
      calls.connect.push([sessionId, options]);
    },
    disconnect() {
      calls.disconnect += 1;
      sdk.sessionId = null;
    },
    send: async () => ({ started: true }),
    stop() {},
    respondInteraction: async () => {},
    resume: async () => true,
  };
  return { sdk, calls };
}

function installFakeSessionSocketEnv() {
  const originalWebSocket = globalThis.WebSocket;
  const originalLocation = globalThis.location;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { protocol: 'http:', host: 'localhost:5174' },
  });

  return () => {
    globalThis.WebSocket = originalWebSocket;
    if (originalLocation === undefined) {
      delete globalThis.location;
    } else {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  };
}

test('SDK 连接携带历史 cursor，并把事件交给现有 Session dispatcher', async () => {
  const deps = createConnectionDeps();
  const { sdk, calls } = createSdkMock();
  deps.chatSdkClient = sdk;
  const connection = useSessionAgentClient(deps);

  connection.initializeSessionEventCursor('session-1', 4);
  await connection.connectSessionWS('session-1', { historySnapshot: true });
  assert.deepEqual(calls.connect[0], ['session-1', { afterEventSeq: 4, historySnapshot: true }]);

  sdk.emit('event', {
    type: 'session.runtime',
    session_id: 'session-1',
    seq: 5,
    payload: {
      state: 'idle',
      load_strategy: 'history',
      allowed_actions: ['send_message'],
      active_run: null,
      last_run: null,
      pending_interactions: [],
      resume_interaction_id: null,
      maintenance: null,
      observed_at: '2026-07-31T00:00:00.000Z',
    },
  });

  assert.equal(useSessionRunStore().sessionRuntime.state, 'idle');
  assert.deepEqual(useSessionRunStore().sessionRuntime.allowed_actions, ['send_message']);
  assert.equal(connection.getLastEventSeq('session-1'), 5);

  await connection.reconnectSessionWS('session-1', { historySnapshot: true });
  assert.equal(calls.disconnect, 1);
  assert.deepEqual(calls.connect[1], ['session-1', { afterEventSeq: 5, historySnapshot: true }]);
});

test('session connection 重连时使用已观察到的 seq durable cursor', async () => {
  const restore = installFakeSessionSocketEnv();

  try {
    const connection = useSessionAgentClient(createConnectionDeps());

    await connection.connectSessionWS('session-1');
    assert.equal(FakeWebSocket.instances[0].url, 'ws://localhost:5174/api/agent/sessions/session-1/ws?ticket=ticket-1');

    FakeWebSocket.instances[0].emit({ type: 'run_started', seq: 3, run_id: 'run-1' });
    assert.equal(connection.getLastEventSeq('session-1'), 3);

    connection.disconnectSessionWS();
    await connection.connectSessionWS('session-1');
    assert.equal(
      FakeWebSocket.instances[1].url,
      'ws://localhost:5174/api/agent/sessions/session-1/ws?after_seq=3&ticket=ticket-2',
    );

    // seq 3 已投递过（cursor=3），重连后重复投递被 shouldDeliverEvent 拦截；seq 4 推进 cursor
    FakeWebSocket.instances[1].emit({ type: 'run_started', seq: 3, run_id: 'run-1' });
    FakeWebSocket.instances[1].emit({ type: 'stream_output', seq: 4, payload: { phase: 'delta', content: 'x' } });

    assert.equal(connection.getLastEventSeq('session-1'), 4);
  } finally {
    restore();
  }
});

test('session connection 使用 heartbeat.last_seq 推进重连 cursor', async () => {
  const restore = installFakeSessionSocketEnv();

  try {
    const connection = useSessionAgentClient(createConnectionDeps());

    await connection.connectSessionWS('session-1');
    FakeWebSocket.instances[0].emit({ type: 'heartbeat', payload: { last_seq: 5 } });
    assert.equal(connection.getLastEventSeq('session-1'), 5);

    FakeWebSocket.instances[0].emit({ type: 'heartbeat', payload: { last_seq: 3 } });
    assert.equal(connection.getLastEventSeq('session-1'), 5);

    connection.disconnectSessionWS();
    await connection.connectSessionWS('session-1');
    assert.equal(
      FakeWebSocket.instances[1].url,
      'ws://localhost:5174/api/agent/sessions/session-1/ws?after_seq=5&ticket=ticket-2',
    );

    FakeWebSocket.instances[1].emit({ type: 'stream_output', seq: 5, payload: { phase: 'delta', content: 'duplicate' } });
    FakeWebSocket.instances[1].emit({ type: 'stream_output', payload: { phase: 'delta', content: 'transport only' } });
    FakeWebSocket.instances[1].emit({ type: 'stream_output', seq: 6, payload: { phase: 'delta', content: 'next' } });

    assert.equal(connection.getLastEventSeq('session-1'), 6);
  } finally {
    restore();
  }
});

test('session connection 可从消息快照水位初始化 durable cursor', async () => {
  const restore = installFakeSessionSocketEnv();

  try {
    const connection = useSessionAgentClient(createConnectionDeps());

    await connection.connectSessionWS('session-1');
    FakeWebSocket.instances[0].emit({ type: 'stream_output', seq: 9, payload: { phase: 'delta', content: 'x' } });
    assert.equal(connection.getLastEventSeq('session-1'), 9);

    connection.disconnectSessionWS();
    connection.initializeSessionEventCursor('session-1', 4);
    assert.equal(connection.getLastEventSeq('session-1'), 4);

    await connection.connectSessionWS('session-1');
    assert.equal(FakeWebSocket.instances[1].url, 'ws://localhost:5174/api/agent/sessions/session-1/ws?after_seq=4&ticket=ticket-2');
  } finally {
    restore();
  }
});

test('切换 session 后会丢弃旧 session 迟到的 ticket', async () => {
  const restore = installFakeSessionSocketEnv();
  let resolveFirstTicket;
  try {
    const deps = createConnectionDeps();
    deps.issueSessionWsTicket = (sessionId) => sessionId === 'session-1'
      ? new Promise((resolve) => { resolveFirstTicket = resolve; })
      : Promise.resolve({ data: { ticket: 'ticket-2' } });
    const connection = useSessionAgentClient(deps);

    const firstConnection = connection.connectSessionWS('session-1');
    deps.currentSessionId.value = 'session-2';
    await connection.connectSessionWS('session-2');
    resolveFirstTicket({ data: { ticket: 'stale-ticket' } });
    await firstConnection;

    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(FakeWebSocket.instances[0].url, 'ws://localhost:5174/api/agent/sessions/session-2/ws?ticket=ticket-2');
  } finally {
    restore();
  }
});
