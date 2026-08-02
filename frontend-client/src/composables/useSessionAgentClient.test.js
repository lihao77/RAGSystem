import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

import { useSessionAgentClient } from './useSessionAgentClient.js';
import { useSessionRunStore } from '../stores/session-run.js';

function createConnectionDeps(chatSdkClient) {
  setActivePinia(createPinia());
  const sessionRunStore = useSessionRunStore();
  const { currentSessionId, messages, isLoading, isCompressing } = storeToRefs(sessionRunStore);
  currentSessionId.value = 'session-1';
  const noop = () => {};
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
    userInputDialogRef: ref(null),
    chatSdkClient,
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

test('SDK 连接携带历史 cursor，并把事件交给现有 Session dispatcher', async () => {
  const { sdk, calls } = createSdkMock();
  const connection = useSessionAgentClient(createConnectionDeps(sdk));

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

test('已连接同一会话的普通连接请求不会触发游标重连', async () => {
  const { sdk, calls } = createSdkMock();
  sdk.sessionId = 'session-1';
  sdk.isConnected = true;
  const connection = useSessionAgentClient(createConnectionDeps(sdk));

  connection.initializeSessionEventCursor('session-1', 12);
  await connection.connectSessionWS('session-1');

  assert.deepEqual(calls.connect, []);
  assert.equal(calls.disconnect, 0);
});

test('SDK heartbeat watermark only advances the durable cursor', () => {
  const { sdk } = createSdkMock();
  const connection = useSessionAgentClient(createConnectionDeps(sdk));

  sdk.emit('event', { type: 'heartbeat', session_id: 'session-1', payload: { last_seq: 5 } });
  sdk.emit('event', { type: 'heartbeat', session_id: 'session-1', payload: { last_seq: 3 } });

  assert.equal(connection.getLastEventSeq('session-1'), 5);
});
