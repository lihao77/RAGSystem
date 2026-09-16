import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';
import { isSessionRunning, useSessionListStates } from './useSessionListStates.js';

test('list states use initial data, batch refresh, and preserve newer WebSocket facts', async (t) => {
  setActivePinia(createPinia());
  t.mock.timers.enable({ apis: ['setInterval'] });
  const previousDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const scope = effectScope();
  t.after(() => { scope.stop(); globalThis.document = previousDocument; });
  const items = ref([{ session_id: 'a', runtime_state: 'running' }, { session_id: 'b', runtime_state: 'idle' }]);
  const calls = [];
  let resolve;
  const isRunning = scope.run(() => useSessionListStates(items, () => ({
    getSessionListStates: async ids => {
      calls.push(ids);
      return new Promise(done => { resolve = done; });
    },
  })));
  assert.equal(isRunning(items.value[0]), true);
  assert.equal(isRunning(items.value[1]), false);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(10_000);
  assert.deepEqual(calls, [['a', 'b']]);
  const run = useSessionRunStore();
  run.currentSessionId = 'a';
  run.sessionRuntime = { state: 'idle' };
  await nextTick();
  resolve({ data: { items: [{ session_id: 'a', state: 'running' }, { session_id: 'b', state: 'resuming' }] } });
  await new Promise(done => setImmediate(done));
  run.currentSessionId = 'b';
  run.sessionRuntime = null;
  await nextTick();
  assert.equal(isRunning(items.value[0]), false);
  assert.equal(isRunning(items.value[1]), true);
  document.visibilityState = 'hidden';
  t.mock.timers.tick(10_000);
  assert.equal(calls.length, 1);
  scope.stop();
  t.mock.timers.tick(10_000);
  assert.equal(calls.length, 1);
});

test('idle, suspended and waiting sessions do not display a running spinner', () => {
  for (const state of [undefined, 'idle', 'waiting_interaction', 'suspended', 'maintenance']) assert.equal(isSessionRunning(state), false);
  assert.equal(isSessionRunning('running'), true);
  assert.equal(isSessionRunning('resuming'), true);
});
