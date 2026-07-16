import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionRunRecovery } from './sessionRunRecovery.js';

function createHarness(overrides = {}) {
  const callbacks = [];
  const calls = { deleted: [], loaded: [], refreshed: [] };
  let currentSessionId = 'session-1';
  const activeRun = {
    active: true,
    assistantMsgIndex: 0,
    lastSeenSeq: 0,
    isReplaying: false,
    phase: 'llm_streaming',
  };
  const messages = { value: [{ role: 'assistant', content: '', metadata: {}, finished: false }] };
  const isLoading = { value: true };
  const recovery = createSessionRunRecovery({
    getCurrentSessionId: () => currentSessionId,
    activeRun,
    messages,
    isLoading,
    deleteMessageCache: (...args) => calls.deleted.push(args),
    loadSessionMessages: async (...args) => calls.loaded.push(args),
    refreshSessionExecutionState: async (...args) => calls.refreshed.push(args),
    fetchTaskStatus: async () => ({ data: { has_running_task: false } }),
    scheduleTimer: callback => {
      callbacks.push(callback);
      return callbacks.length;
    },
    cancelTimer: () => {},
    ...overrides,
  });
  return {
    recovery,
    callbacks,
    calls,
    activeRun,
    messages,
    isLoading,
    setCurrentSessionId: value => { currentSessionId = value; },
  };
}

test('SessionRunRecovery finalizes a missing command result and reloads the session', () => {
  const harness = createHarness();
  harness.recovery.scheduleCommandFallback('session-1', 0, 10000);
  harness.callbacks[0]();

  assert.equal(harness.messages.value[0].content, '[命令执行超时或结果未送达]');
  assert.equal(harness.messages.value[0].finished, true);
  assert.equal(harness.activeRun.active, false);
  assert.equal(harness.isLoading.value, false);
  assert.deepEqual(harness.calls.deleted, [['session-1']]);
  assert.deepEqual(harness.calls.loaded, [['session-1', { silent: true }]]);
});

test('SessionRunRecovery reconciles an active local run after the server reports idle', async () => {
  const harness = createHarness();
  harness.recovery.scheduleSessionResumeRecovery('session-1', 1500);
  await harness.callbacks[0]();

  assert.equal(harness.activeRun.active, false);
  assert.deepEqual(harness.calls.deleted, [['session-1']]);
  assert.deepEqual(harness.calls.loaded, [['session-1', { silent: true }]]);
  assert.deepEqual(harness.calls.refreshed, []);
});

test('SessionRunRecovery ignores a watchdog callback from a stale session', async () => {
  const harness = createHarness();
  harness.recovery.scheduleSessionResumeRecovery('session-1', 1500);
  harness.setCurrentSessionId('session-2');
  await harness.callbacks[0]();

  assert.equal(harness.activeRun.active, true);
  assert.deepEqual(harness.calls.deleted, []);
  assert.deepEqual(harness.calls.loaded, []);
  assert.deepEqual(harness.calls.refreshed, []);
});
