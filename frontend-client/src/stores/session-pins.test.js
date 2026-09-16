import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionListStore } from './session-list.js';
import { MAX_PINNED_SESSIONS, normalizePinnedSessionIds } from './session-list-hydration.js';

const key = 'ragsystem:pinned-sessions:local:local';
const item = id => ({ session_id: id, title: id, first_message: '', last_message: '', activity_at: '2026-09-15T00:00:00Z', unread_count: 0, origin: { type: 'direct', channel: 'web', id: null, display_name: '直接对话' }, workspace: null });

test('pin preferences normalize missing, malformed and partially edited shapes idempotently', () => {
  for (const [input, expected] of [
    [null, []],
    [{ ids: ['a'] }, []],
    [[' a ', 'a', '', null, 42, 'b'], ['a', 'b']],
  ]) {
    assert.deepEqual(normalizePinnedSessionIds(input), expected);
    assert.deepEqual(normalizePinnedSessionIds(normalizePinnedSessionIds(input)), expected);
  }
});

test('pin limit counts filtered-out sessions, rejects additions without mutation, and allows unpinning', (t) => {
  localStorage.clear();
  setActivePinia(createPinia());
  const store = useSessionListStore();
  t.after(() => { store.dispose(); store.$dispose(); localStorage.clear(); });
  const entries = Array.from({ length: MAX_PINNED_SESSIONS }, (_, index) => item(`session-${index}`));
  for (const entry of entries) assert.equal(store.togglePin(entry), true);
  const persisted = localStorage.getItem(key);
  const listBefore = [...store.items];
  store.filters = { originType: 'bot', originId: null, workspaceId: null };
  assert.equal(store.pinnedItems.length, 0);
  assert.equal(store.togglePin(item('overflow')), false);
  assert.equal(localStorage.getItem(key), persisted);
  assert.deepEqual(store.items, listBefore);

  assert.equal(store.togglePin(entries[0]), true);
  assert.equal(store.togglePin(item('replacement')), true);
  assert.equal(JSON.parse(localStorage.getItem(key)).length, MAX_PINNED_SESSIONS);
  assert.equal(JSON.parse(localStorage.getItem(key))[0], 'replacement');
  assert.ok(!JSON.parse(localStorage.getItem(key)).includes(entries[0].session_id));
});

test('pins at the limit restore in one request without changing preferences', async (t) => {
  localStorage.clear();
  const ids = Array.from({ length: MAX_PINNED_SESSIONS }, (_, index) => `session-${index}`);
  localStorage.setItem(key, JSON.stringify(ids));
  setActivePinia(createPinia());
  const store = useSessionListStore();
  t.after(() => { store.dispose(); store.$dispose(); localStorage.clear(); });
  const calls = [];
  store.setChatSdkClient({ listSessions: async options => {
    calls.push(options);
    return { data: { items: options.sessionIds.map(item), next_cursor: null } };
  } });
  await store.loadPins();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, MAX_PINNED_SESSIONS);
  assert.deepEqual(calls[0].sessionIds, ids);
  assert.deepEqual(store.pinnedItems.map(entry => entry.session_id), ids);
  assert.deepEqual(JSON.parse(localStorage.getItem(key)), ids);
});

test('restoring long Unicode pin IDs keeps requests below the proxy limit without losing pins', async (t) => {
  localStorage.clear();
  const ids = Array.from({ length: MAX_PINNED_SESSIONS }, (_, index) => `${'会'.repeat(198)}${index}`);
  localStorage.setItem(key, JSON.stringify(ids));
  setActivePinia(createPinia());
  const store = useSessionListStore();
  t.after(() => { store.dispose(); store.$dispose(); localStorage.clear(); });
  let requests = 0;
  store.setChatSdkClient({ listSessions: async options => {
    requests++;
    const query = new URLSearchParams({ session_ids: JSON.stringify(options.sessionIds), limit: String(options.limit) });
    assert.ok(Buffer.byteLength(`GET /api/agent/sessions?${query} HTTP/1.1\r\n`) < 8192);
    return { data: { items: options.sessionIds.map(item), next_cursor: null } };
  } });
  await store.loadPins();
  assert.ok(requests > 1);
  assert.deepEqual(store.pinnedItems.map(entry => entry.session_id), ids);
  assert.deepEqual(JSON.parse(localStorage.getItem(key)), ids);
});

test('pins survive list replacement, restore in one batch, and unpin back into the list', async (t) => {
  localStorage.clear();
  t.after(() => localStorage.clear());
  setActivePinia(createPinia());
  const store = useSessionListStore();
  store.upsert(item('old'));
  store.upsert(item('recent'));
  store.togglePin(item('old'));
  assert.deepEqual(store.unpinnedItems.map(entry => entry.session_id), ['recent']);
  store.items = [item('recent')];
  assert.equal(store.pinnedItems[0].session_id, 'old');
  store.updateTitle('old', 'new title');
  assert.equal(store.pinnedItems[0].title, 'new title');
  store.$dispose();

  setActivePinia(createPinia());
  const restored = useSessionListStore();
  const calls = [];
  restored.setChatSdkClient({ listSessions: async options => {
    calls.push(options.sessionIds);
    return { data: { items: [item('old')], next_cursor: null } };
  } });
  await restored.loadPins();
  assert.deepEqual(calls, [['old']]);
  assert.deepEqual(restored.pinnedItems.map(entry => entry.session_id), ['old']);
  restored.togglePin(restored.pinnedItems[0]);
  assert.equal(restored.pinnedItems.length, 0);
  assert.equal(restored.unpinnedItems[0].session_id, 'old');
  assert.deepEqual(JSON.parse(localStorage.getItem(key)), []);
  restored.$dispose();
});

for (const loaded of [true, false]) {
  test(`late pin restoration preserves newer title and activity (${loaded ? 'loaded' : 'outside current page'})`, async (t) => {
    localStorage.clear();
    setActivePinia(createPinia());
    const store = useSessionListStore();
    t.after(() => { store.dispose(); store.$dispose(); localStorage.clear(); });
    const stale = item('pinned');
    store.togglePin(stale);
    if (!loaded) store.items = [];
    let resolve;
    store.setChatSdkClient({ listSessions: () => new Promise(done => { resolve = done; }) });
    const pending = store.loadPins();
    store.updateTitle('pinned', 'new title');
    store.updateActivity('pinned', { lastMessage: 'new message', activityAt: '2026-09-15T01:00:00Z', unreadCount: 3 });
    const updated = { ...store.pinnedItems[0] };
    resolve({ data: { items: [stale], next_cursor: null } });
    await pending;
    assert.deepEqual(store.pinnedItems[0], updated);
    assert.equal(store.pinnedItems[0].title, 'new title');
    assert.equal(store.pinnedItems[0].last_message, 'new message');
    assert.equal(store.pinnedItems[0].unread_count, 3);
    if (loaded) assert.deepEqual(store.pinnedItems[0], store.items[0]);
    else assert.equal(store.items.length, 0);
  });
}

test('list snapshots and pin changes during restoration take precedence over the response', async (t) => {
  localStorage.clear();
  setActivePinia(createPinia());
  const store = useSessionListStore();
  t.after(() => { store.dispose(); store.$dispose(); localStorage.clear(); });
  for (const id of ['refreshed', 'removed', 'repinned']) store.togglePin(item(id));
  let resolve;
  store.setChatSdkClient({ listSessions: () => new Promise(done => { resolve = done; }) });
  const pending = store.loadPins();
  store.items = [{ ...item('refreshed'), title: 'fresh list title' }];
  store.remove('removed');
  store.togglePin(item('repinned'));
  store.togglePin(item('repinned'));
  resolve({ data: { items: [item('refreshed'), item('removed')], next_cursor: null } });
  await pending;
  assert.equal(store.pinnedItems.find(entry => entry.session_id === 'refreshed').title, 'fresh list title');
  assert.ok(!store.pinnedItems.some(entry => entry.session_id === 'removed'));
  assert.ok(store.pinnedItems.some(entry => entry.session_id === 'repinned'));
  assert.deepEqual(JSON.parse(localStorage.getItem(key)), ['repinned', 'refreshed']);
});

test('deleted or inaccessible pins are removed on restore; deleting a pin clears preferences', async (t) => {
  localStorage.clear();
  t.after(() => localStorage.clear());
  localStorage.setItem(key, JSON.stringify(['gone', 'kept', 'kept', 7]));
  setActivePinia(createPinia());
  const store = useSessionListStore();
  store.setChatSdkClient({ listSessions: async () => ({ data: { items: [item('kept')], next_cursor: null } }) });
  await store.loadPins();
  assert.deepEqual(JSON.parse(localStorage.getItem(key)), ['kept']);
  store.remove('kept');
  assert.equal(store.pinnedItems.length, 0);
  assert.deepEqual(JSON.parse(localStorage.getItem(key)), []);
  store.$dispose();
});
