import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionRunRecovery } from './sessionRunRecovery.js';

function createHarness(overrides = {}) {
  const callbacks = [];
  const calls = { deleted: [], loaded: [], finishedOptimisticCommand: 0 };
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
    messages,
    isLoading,
    deleteMessageCache: (...args) => calls.deleted.push(args),
    loadSessionMessages: async (...args) => calls.loaded.push(args),
    finishOptimisticCommand: () => {
      calls.finishedOptimisticCommand += 1;
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
  harness.recovery.scheduleCommandFallback('session-1', 0, 10000);
  harness.callbacks[0]();

  assert.equal(harness.messages.value[0].content, '[命令执行超时或结果未送达]');
  assert.equal(harness.messages.value[0].finished, true);
  assert.equal(harness.activeRun.active, false);
  assert.equal(harness.isLoading.value, false);
  assert.equal(harness.calls.finishedOptimisticCommand, 1);
  assert.deepEqual(harness.calls.deleted, [['session-1']]);
  assert.deepEqual(harness.calls.loaded, [['session-1', { silent: true }]]);
});

test('SessionRunRecovery ignores a stale command fallback after runtime becomes idle', () => {
  const harness = createHarness();
  harness.recovery.scheduleCommandFallback('session-1', 0, 10000);
  harness.isLoading.value = false;
  harness.callbacks[0]();

  assert.equal(harness.activeRun.active, true);
  assert.equal(harness.messages.value[0].finished, false);
  assert.equal(harness.calls.finishedOptimisticCommand, 0);
  assert.deepEqual(harness.calls.deleted, []);
  assert.deepEqual(harness.calls.loaded, []);
});
