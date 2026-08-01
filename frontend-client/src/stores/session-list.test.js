import test from 'node:test';
import assert from 'node:assert/strict';
import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia } from 'pinia';

import { httpClient } from '../api/http.js';
import { useSessionListStore } from './session-list.js';

const directOrigin = {
  type: 'direct',
  id: null,
  display_name: '直接对话',
  channel: 'web',
};

function item(sessionId, activityAt, overrides = {}) {
  return {
    session_id: sessionId,
    title: sessionId,
    first_message: '',
    last_message: '',
    activity_at: activityAt,
    unread_count: 0,
    origin: directOrigin,
    workspace: null,
    ...overrides,
  };
}

function response(data) {
  return { success: true, message: 'ok', data };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createTestStore() {
  const store = useSessionListStore();
  store.setChatSdkClient({
    listSessions(options = {}) {
      return httpClient.get('/api/agent/sessions', {
        params: {
          limit: options.limit ?? 20,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.originType ? { origin_type: options.originType } : {}),
          ...(options.originId ? { origin_id: options.originId } : {}),
          ...(options.workspaceId ? { workspace_id: options.workspaceId } : {}),
        },
        signal: options.signal,
      });
    },
    getSessionFacets({ signal } = {}) {
      return httpClient.get('/api/agent/sessions/facets', { signal });
    },
  });
  return store;
}

test('cursor pages append, dedupe, and keep stable activity ordering', async (t) => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  t.after(() => mock.restore());
  const seenParams = [];
  mock.onGet('/api/agent/sessions').reply((config) => {
    seenParams.push(config.params);
    if (!config.params.cursor) {
      return [200, response({
        items: [item('session-b', '2026-07-26T10:00:00.000Z'), item('session-a', '2026-07-26T10:00:00.000Z')],
        next_cursor: 'cursor-1',
      })];
    }
    return [200, response({
      items: [item('session-a', '2026-07-26T10:00:00.000Z'), item('session-old', '2026-07-25T10:00:00.000Z')],
      next_cursor: null,
    })];
  });

  const store = createTestStore();
  await store.load({ reset: true });
  await store.load();

  assert.deepEqual(store.items.map(entry => entry.session_id), ['session-b', 'session-a', 'session-old']);
  assert.equal(store.nextCursor, null);
  assert.equal(seenParams[1].cursor, 'cursor-1');
});

test('filter change resets the cursor and sends source and workspace filters', async (t) => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  t.after(() => mock.restore());
  const seenParams = [];
  mock.onGet('/api/agent/sessions').reply((config) => {
    seenParams.push(config.params);
    return [200, response({ items: [], next_cursor: null })];
  });

  const store = createTestStore();
  await store.load({ reset: true });
  await store.setFilters({ originType: 'bot', originId: 'bot-1', workspaceId: 'workspace-1' });

  assert.deepEqual(store.filters, {
    originType: 'bot',
    originId: 'bot-1',
    workspaceId: 'workspace-1',
  });
  assert.deepEqual(seenParams[1], {
    limit: 20,
    origin_type: 'bot',
    origin_id: 'bot-1',
    workspace_id: 'workspace-1',
  });
});

test('live upsert reorders matching items and removes items outside active filters', async (t) => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  t.after(() => mock.restore());
  mock.onGet('/api/agent/sessions').reply(200, response({ items: [], next_cursor: null }));

  const store = createTestStore();
  await store.setFilters({ originType: 'bot', originId: null });
  const botOrigin = { type: 'bot', id: 'bot-1', display_name: '售后助手', channel: 'api' };
  store.upsert(item('session-old', '2026-07-25T10:00:00.000Z', { origin: botOrigin }));
  store.upsert(item('session-new', '2026-07-26T10:00:00.000Z', { origin: botOrigin }));
  store.upsert(item('session-old', '2026-07-27T10:00:00.000Z', { origin: botOrigin }));
  assert.deepEqual(store.items.map(entry => entry.session_id), ['session-old', 'session-new']);

  store.upsert(item('session-old', '2026-07-27T10:00:00.000Z', { origin: directOrigin }));
  assert.deepEqual(store.items.map(entry => entry.session_id), ['session-new']);
});

test('activity updates preserve projected identity fields and ignore unloaded sessions', () => {
  setActivePinia(createPinia());
  const store = createTestStore();
  const original = item('session-a', '2026-07-25T10:00:00.000Z', {
    title: '稳定标题',
    first_message: '第一条消息',
    last_message: '旧消息',
  });
  store.upsert(original);

  const updated = store.updateActivity('session-a', {
    lastMessage: '最新消息',
    activityAt: '2026-07-26T10:00:00.000Z',
    unreadCount: 3,
  });

  assert.equal(updated.title, '稳定标题');
  assert.equal(updated.first_message, '第一条消息');
  assert.equal(updated.last_message, '最新消息');
  assert.equal(updated.activity_at, '2026-07-26T10:00:00.000Z');
  assert.equal(updated.unread_count, 3);
  assert.equal(store.updateActivity('not-loaded', { lastMessage: '不能生成伪条目' }), null);
  assert.equal(store.items.length, 1);
});

test('local session mutations survive an older in-flight reset response', async (t) => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  t.after(() => mock.restore());
  const pendingResponse = deferred();
  mock.onGet('/api/agent/sessions').reply(() => pendingResponse.promise);

  const store = createTestStore();
  store.upsert(item('session-existing', '2026-07-25T10:00:00.000Z', {
    last_message: '旧的本地消息',
  }));

  const pendingLoad = store.load({ reset: true });
  store.updateActivity('session-existing', {
    lastMessage: '请求期间的新消息',
    activityAt: '2026-07-27T10:00:00.000Z',
  });
  store.upsert(item('session-created', '2026-07-28T10:00:00.000Z'));

  pendingResponse.resolve([200, response({
    items: [
      item('session-existing', '2026-07-25T10:00:00.000Z', { last_message: '服务端旧快照' }),
      item('session-server', '2026-07-26T10:00:00.000Z'),
    ],
    next_cursor: null,
  })]);
  await pendingLoad;

  assert.deepEqual(store.items.map(entry => entry.session_id), [
    'session-created',
    'session-existing',
    'session-server',
  ]);
  assert.equal(store.getById('session-existing').last_message, '请求期间的新消息');
});

test('facet refresh clears unavailable instance and workspace filters', async (t) => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  t.after(() => mock.restore());
  const listParams = [];
  mock.onGet('/api/agent/sessions').reply((config) => {
    listParams.push(config.params);
    return [200, response({ items: [], next_cursor: null })];
  });
  mock.onGet('/api/agent/sessions/facets').reply(200, response({
    type_counts: { direct: 0, bot: 0, widget: 0 },
    origins: [],
    workspaces: [],
  }));

  const store = createTestStore();
  await store.setFilters({ originType: 'bot', originId: 'missing-bot', workspaceId: 'missing-workspace' });
  await store.loadFacets();

  assert.deepEqual(store.filters, {
    originType: 'bot',
    originId: null,
    workspaceId: null,
  });
  assert.equal(listParams.length, 2);
  assert.deepEqual(listParams[1], { limit: 20, origin_type: 'bot' });
});

test('new workspace session updates facets immediately and reconciles with the server', async (t) => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  t.after(() => mock.restore());
  mock.onGet('/api/agent/sessions/facets').reply(200, response({
    type_counts: { direct: 1, bot: 0, widget: 0 },
    origins: [],
    workspaces: [{
      workspace_id: 'workspace-1',
      display_name: 'ragsystem',
      root_path: 'D:/python/ragsystem',
      count: 1,
    }],
  }));

  const store = createTestStore();
  const created = item('session-workspace', '2026-07-26T10:00:00.000Z', {
    workspace: {
      workspace_id: 'workspace-1',
      display_name: 'ragsystem',
      root_path: 'D:/python/ragsystem',
    },
  });

  store.syncCreatedSessionFacets(created);
  store.syncCreatedSessionFacets(created);

  assert.equal(store.facets.type_counts.direct, 1);
  assert.deepEqual(store.facets.workspaces, [{
    workspace_id: 'workspace-1',
    display_name: 'ragsystem',
    root_path: 'D:/python/ragsystem',
    count: 1,
  }]);

  await store.loadFacets();
  assert.equal(store.facets.workspaces[0].count, 1);
});
