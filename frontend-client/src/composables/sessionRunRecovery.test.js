import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionRunRecovery } from './sessionRunRecovery.js';

function createHarness(overrides = {}) {
  const callbacks = [];
  const calls = { deleted: [], loaded: [], finishedPendingCommand: 0 };
  const activeRun = {
    active: true,
    assistantMsgIndex: 0,
    lastSeenSeq: 0,
    isReplaying: false,
    phase: 'model_streaming',
  };
  const messages = { value: [{ role: 'assistant', content: '', metadata: {}, finished: false }] };
  const isLoading = { value: true };
  const recovery = createSessionRunRecovery({
    activeRun,
    isLoading,
    deleteMessageCache: (...args) => calls.deleted.push(args),
    loadSessionMessages: async (...args) => calls.loaded.push(args),
    finishPendingCommand: () => {
      calls.finishedPendingCommand += 1;
      isLoading.value = false;
      activeRun.active = false;
    },
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
  };
}

test('SessionRunRecovery finalizes a missing command result and reloads the session', () => {
  const harness = createHarness();
  harness.recovery.scheduleCommandFallback('session-1', 10000);
  harness.callbacks[0]();

  assert.equal(harness.messages.value[0].content, '');
  assert.equal(harness.messages.value[0].finished, false);
  assert.equal(harness.activeRun.active, false);
  assert.equal(harness.isLoading.value, false);
  assert.equal(harness.calls.finishedPendingCommand, 1);
  assert.deepEqual(harness.calls.deleted, [['session-1']]);
  assert.deepEqual(harness.calls.loaded, [['session-1', { silent: true }]]);
});

test('SessionRunRecovery ignores a stale command fallback after runtime becomes idle', () => {
  const harness = createHarness();
  harness.recovery.scheduleCommandFallback('session-1', 10000);
  harness.isLoading.value = false;
  harness.callbacks[0]();

  assert.equal(harness.activeRun.active, true);
  assert.equal(harness.messages.value[0].finished, false);
  assert.equal(harness.calls.finishedPendingCommand, 0);
  assert.deepEqual(harness.calls.deleted, []);
  assert.deepEqual(harness.calls.loaded, []);
});
