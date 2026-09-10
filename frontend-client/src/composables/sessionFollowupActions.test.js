import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';
import { createSessionFollowupRecovery } from './sessionFollowupRecovery.js';
import { createSessionFollowupActions } from './sessionFollowupActions.js';

function setup(t) {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.currentSessionId = 's1';
  let receipt = { request_id: 'r1', status: 'queued', content: '原文', can_manage: true, can_edit: true };
  const calls = [];
  const sdk = {
    listMessageRequestStatuses: async () => ({ data: { items: [receipt] } }),
    cancelQueuedMessageRequest: async (...args) => {
      calls.push(['cancel', ...args]); receipt = { ...receipt, status: 'cancelled', can_manage: false };
      return { data: { item: receipt } };
    },
  };
  const toasts = [];
  const showToast = (...args) => toasts.push(args);
  const recovery = createSessionFollowupRecovery({ sdk, store, loadMessages: async () => 0, showToast, intervalMs: 60000 });
  t.after(() => recovery.dispose());
  const actions = createSessionFollowupActions({ sdk, store, recovery, showToast });
  return { store, sdk, calls, toasts, recovery, actions };
}

test('taking back a pending input cancels it and removes the pending row without a failure toast', async t => {
  const { store, recovery, actions, calls, toasts } = setup(t);
  await recovery.refresh();
  assert.equal(await actions.takeBack({ ...store.currentPendingFollowups[0] }), true);
  assert.deepEqual(calls, [['cancel', 's1', 'r1', '原文']]);
  assert.equal(store.currentPendingFollowups.length, 0);
  assert.deepEqual(toasts, []);
  await recovery.refresh();
  assert.equal(store.currentPendingFollowups.length, 0);
});

test('a query issued before taking back cannot restore the previous row', async t => {
  const { store, sdk, recovery, actions } = setup(t);
  await recovery.refresh();
  let resolveRead;
  sdk.listMessageRequestStatuses = () => new Promise(resolve => { resolveRead = resolve; });
  const reading = recovery.refresh();
  const editing = actions.takeBack({ ...store.currentPendingFollowups[0] });
  await Promise.resolve();
  resolveRead({ data: { items: [{ request_id: 'r1', status: 'queued', content: '原文', can_manage: true, can_edit: true }] } });
  await Promise.all([reading, editing]);
  assert.equal(store.currentPendingFollowups.length, 0);
});

test('conflicts refresh a consumed message and inactive/uncertain rows reject mutations', async t => {
  const { store, sdk, recovery, actions, toasts, calls } = setup(t);
  await recovery.refresh();
  const original = { ...store.currentPendingFollowups[0] };
  store.markFollowupsUnconfirmed('s1');
  assert.equal(await actions.cancel(original), false);
  store.currentSessionId = 's2';
  assert.equal(await actions.takeBack(original), false);
  assert.equal(calls.length, 0);
  store.currentSessionId = 's1';
  await recovery.refresh();
  sdk.cancelQueuedMessageRequest = async () => { throw new Error('消息已被处理'); };
  sdk.listMessageRequestStatuses = async () => ({ data: { items: [{ request_id: 'r1', status: 'consumed', content: '原文' }] } });
  assert.equal(await actions.takeBack(original), false);
  assert.equal(store.currentPendingFollowups.length, 0);
  assert.deepEqual(toasts, [['消息已被处理', 'warning']]);
});

test('duplicate clicks are ignored and network failure retains content until reconciliation', async t => {
  const { store, sdk, recovery, actions } = setup(t);
  await recovery.refresh();
  let reject;
  sdk.cancelQueuedMessageRequest = () => new Promise((_, fail) => { reject = fail; });
  const original = { ...store.currentPendingFollowups[0] };
  const cancelling = actions.cancel(original);
  assert.equal(await actions.cancel(original), false);
  reject(new Error('offline'));
  assert.equal(await cancelling, false);
  assert.equal(store.currentPendingFollowups[0].content, '原文');
  assert.equal(store.currentPendingFollowups[0].mutating, false);
});
