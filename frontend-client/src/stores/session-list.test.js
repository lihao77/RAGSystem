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
    listSessionWorkspacePreview(options = {}) {
      return httpClient.get('/api/agent/sessions/workspace-preview', {
        params: {
          limit: options.limit ?? 5,
          ...(options.originType ? { origin_type: options.originType } : {}),
          ...(options.originId ? { origin_id: options.originId } : {}),
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

test('loadWorkspace pages one workspace, chases duplicate pages, and marks exhaustion', async (t) => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  t.after(() => mock.restore());
  const workspace = { workspace_id: 'workspace-1', display_name: 'ragsystem', root_path: null };
  const workspaceParams = [];
  mock.onGet('/api/agent/sessions').reply((config) => {
    const params = config.params;
    if (params.workspace_id === 'workspace-1') {
      workspaceParams.push(params);
      if (!params.cursor) {
        // 工作区首页与全局首页整页重复
        return [200, response({
          items: [item('w1-a', '2026-07-26T12:00:00.000Z', { workspace }), item('w1-b', '2026-07-26T11:00:00.000Z', { workspace })],
          next_cursor: 'w1-c1',
        })];
      }
      return [200, response({
        items: [item('w1-old', '2026-07-25T10:00:00.000Z', { workspace })],
        next_cursor: null,
      })];
    }
    return [200, response({
      items: [
        item('w1-a', '2026-07-26T12:00:00.000Z', { workspace }),
        item('w1-b', '2026-07-26T11:00:00.000Z', { workspace }),
        item('w2-a', '2026-07-26T10:00:00.000Z'),
      ],
      next_cursor: null,
    })];
  });

  const store = createTestStore();
  await store.load({ reset: true });
  assert.deepEqual(store.items.map(entry => entry.session_id), ['w1-a', 'w1-b', 'w2-a']);

  await store.loadWorkspace('workspace-1');

  assert.deepEqual(store.items.map(entry => entry.session_id), ['w1-a', 'w1-b', 'w2-a', 'w1-old']);
  assert.equal(store.workspaceCursors['workspace-1'], null);
  assert.equal(store.workspaceHasMore('workspace-1'), false);
  assert.deepEqual(workspaceParams.map(params => params.cursor), [undefined, 'w1-c1']);
  assert.ok(workspaceParams.every(params => params.workspace_id === 'workspace-1'));

  // 取尽后再点不产生新请求
  await store.loadWorkspace('workspace-1');
  assert.equal(workspaceParams.length, 2);
});

test('filter change invalidates workspace cursors', async (t) => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  t.after(() => mock.restore());
  const workspaceParams = [];
  mock.onGet('/api/agent/sessions').reply((config) => {
    const params = config.params;
    if (params.workspace_id === 'workspace-1') {
      workspaceParams.push(params);
      return [200, response({
        items: [item('w1-a', '2026-07-26T12:00:00.000Z', {
          workspace: { workspace_id: 'workspace-1', display_name: 'ragsystem', root_path: null },
        })],
        next_cursor: 'w1-c1',
      })];
    }
    return [200, response({ items: [], next_cursor: null })];
  });

  const store = createTestStore();
  await store.load({ reset: true });
  await store.loadWorkspace('workspace-1');
  assert.equal(store.workspaceCursors['workspace-1'], 'w1-c1');

  await store.setFilters({ originType: 'bot' });

  assert.equal(store.workspaceCursors['workspace-1'], undefined);
  assert.equal(store.workspaceHasMore('workspace-1'), true);
});

test('workspace preview seeds every group first page and its cursor in one request', async (t) => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  t.after(() => mock.restore());
  const quietWorkspace = { workspace_id: 'workspace-quiet', display_name: 'quiet', root_path: null };
  const previewParams = [];
  mock.onGet('/api/agent/sessions').reply(200, response({
    // 全局首页被未归属会话占满，安静项目一条都轮不上
    items: [item('busy-a', '2026-07-26T12:00:00.000Z'), item('busy-b', '2026-07-26T11:00:00.000Z')],
    next_cursor: null,
  }));
  mock.onGet('/api/agent/sessions/workspace-preview').reply((config) => {
    previewParams.push(config.params);
    return [200, response({ groups: [
      { workspace_id: 'workspace-quiet', items: [item('quiet-a', '2026-07-25T10:00:00.000Z', { workspace: quietWorkspace })], next_cursor: 'quiet-c1' },
      { workspace_id: '__unassigned__', items: [item('busy-a', '2026-07-26T12:00:00.000Z')], next_cursor: null },
    ] })];
  });

  const store = createTestStore();
  await store.load({ reset: true });
  await store.loadWorkspacePreview();

  assert.deepEqual(store.items.map(entry => entry.session_id), ['busy-a', 'busy-b', 'quiet-a']);
  assert.equal(store.workspaceCursors['workspace-quiet'], 'quiet-c1');
  assert.equal(store.workspaceCursors['__unassigned__'], null);
  assert.equal(store.workspaceHasMore('workspace-quiet'), true);
  assert.equal(store.workspaceHasMore('__unassigned__'), false);
  assert.deepEqual(previewParams[0], { limit: 5 });

  // 同一筛选生命周期内不重复请求；reset 后失效可重取
  await store.loadWorkspacePreview();
  assert.equal(previewParams.length, 1);
  await store.load({ reset: true });
  await store.loadWorkspacePreview();
  assert.equal(previewParams.length, 2);
});

test('workspace preview skips while a workspace filter is active', async (t) => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  t.after(() => mock.restore());
  let previewCalls = 0;
  mock.onGet('/api/agent/sessions').reply(200, response({ items: [], next_cursor: null }));
  mock.onGet('/api/agent/sessions/workspace-preview').reply(() => {
    previewCalls += 1;
    return [200, response({ groups: [] })];
  });

  const store = createTestStore();
  await store.setFilters({ workspaceId: 'workspace-1' });
  await store.loadWorkspacePreview();

  assert.equal(previewCalls, 0);
});

test('workspace filter disables per-group paging for other workspaces', async (t) => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  t.after(() => mock.restore());
  const workspaceCalls = [];
  mock.onGet('/api/agent/sessions').reply((config) => {
    if (config.params.workspace_id) workspaceCalls.push(config.params.workspace_id);
    return [200, response({ items: [], next_cursor: null })];
  });

  const store = createTestStore();
  await store.setFilters({ workspaceId: 'workspace-1' });
  // setFilters 触发的全局请求也带 workspace_id，排除后再验证组级翻页
  workspaceCalls.length = 0;

  assert.equal(store.workspaceHasMore('workspace-2'), false);
  assert.equal(store.workspaceHasMore('workspace-1'), true);
  // 筛中的组仍可翻页，其他组不再发注定被丢弃的请求
  await store.loadWorkspace('workspace-2');
  assert.deepEqual(workspaceCalls, []);
});

test('workspaceHasMore trusts facet totals to suppress dead buttons on empty projects', async (t) => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  t.after(() => mock.restore());
  mock.onGet('/api/agent/sessions').reply(200, response({ items: [], next_cursor: null }));
  mock.onGet('/api/agent/sessions/facets').reply(200, response({
    type_counts: { direct: 0, bot: 0, widget: 0 },
    origins: [],
    workspaces: [
      { workspace_id: 'workspace-empty', display_name: '空项目', root_path: null, count: 0 },
      { workspace_id: 'workspace-live', display_name: '活跃项目', root_path: null, count: 3 },
    ],
  }));

  const store = createTestStore();
  await store.initialize();

  assert.equal(store.workspaceHasMore('workspace-empty'), false);
  assert.equal(store.workspaceHasMore('workspace-live'), true);
  // 未归属组不在 facets 统计里，保持默认可加载
  assert.equal(store.workspaceHasMore('__unassigned__'), true);
});
