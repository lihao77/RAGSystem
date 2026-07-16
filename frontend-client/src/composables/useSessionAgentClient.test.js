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

test('session connection 可重置 session durable cursor 以支持快照加载后的完整 active replay', async () => {
  const restore = installFakeSessionSocketEnv();

  try {
    const connection = useSessionAgentClient(createConnectionDeps());

    await connection.connectSessionWS('session-1');
    FakeWebSocket.instances[0].emit({ type: 'stream_output', seq: 9, payload: { phase: 'delta', content: 'x' } });
    assert.equal(connection.getLastEventSeq('session-1'), 9);

    connection.disconnectSessionWS();
    connection.resetSessionEventCursor('session-1');
    assert.equal(connection.getLastEventSeq('session-1'), 0);

    await connection.connectSessionWS('session-1');
    assert.equal(FakeWebSocket.instances[1].url, 'ws://localhost:5174/api/agent/sessions/session-1/ws?ticket=ticket-2');
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
