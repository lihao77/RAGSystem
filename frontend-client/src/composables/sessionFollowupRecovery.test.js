import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';
import { createSessionFollowupRecovery } from './sessionFollowupRecovery.js';

const receipt = (request_id, status, content = '补充') => ({ request_id, status, content, error: status === 'failed' ? '发送处理失败' : null });
function harness(t, read, loadMessages = async () => {}) {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.currentSessionId = 's1';
  const toasts = [];
  const recovery = createSessionFollowupRecovery({ sdk: { listMessageRequestStatuses: read }, store, loadMessages,
    showToast: (...args) => toasts.push(args), intervalMs: 60000 });
  t.after(() => recovery.dispose());
  return { store, recovery, toasts };
}

test('switching back resolves persisted send failures without the lost socket error', async t => {
  const { store, recovery, toasts } = harness(t, async () => ({ data: { items: [receipt('r1', 'failed')] } }));
  store.queueFollowup('s1', 'r1', '补充');
  store.markFollowupQueued('s1', 'r1');
  store.currentSessionId = 's2';
  store.currentSessionId = 's1';
  await recovery.refresh();
  assert.equal(store.currentPendingFollowups.length, 0);
  assert.deepEqual(toasts, [['发送处理失败', 'warning']]);
});

test('fresh views restore pending sends and consumption reloads history before removing the row', async t => {
  let items = [receipt('r1', 'processing'), receipt('r2', 'queued')];
  let reloads = 0;
  const { store, recovery } = harness(t, async () => ({ data: { items } }), async (sessionId, options) => {
    reloads++;
    assert.equal(options.preserveStream, true);
    store.reconcilePendingFollowups(sessionId, [{ id: 'user-2', role: 'user', metadata: { request_id: 'r2' } }]);
  });
  await recovery.refresh();
  assert.deepEqual(store.currentPendingFollowups.map(item => item.status), ['processing', 'queued']);
  items = [receipt('r1', 'queued'), receipt('r2', 'consumed')];
  await recovery.refresh();
  assert.equal(reloads, 1);
  assert.deepEqual(store.currentPendingFollowups.map(item => item.request_id), ['r1']);
});

test('an older query cannot resurrect a consumed request or write into a different session', async t => {
  let resolve;
  const { store, recovery } = harness(t, () => new Promise(done => { resolve = done; }));
  const first = recovery.refresh();
  store.removePendingFollowup('s1', 'r1');
  resolve({ data: { items: [receipt('r1', 'queued')] } });
  await first;
  assert.equal(store.currentPendingFollowups.length, 0);
  const next = recovery.refresh();
  store.currentSessionId = 's2';
  resolve({ data: { items: [receipt('r2', 'queued')] } });
  await next;
  assert.equal(store.pendingFollowups.length, 0);
});

test('query errors keep uncertain content available for retry', async t => {
  const { store, recovery, toasts } = harness(t, async () => { throw new Error('offline'); });
  store.queueFollowup('s1', 'r1', '补充');
  store.markFollowupsUnconfirmed('s1');
  await recovery.refresh();
  assert.equal(store.currentPendingFollowups[0].status, 'unconfirmed');
  assert.deepEqual(toasts, []);
});
