import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, ref } from 'vue';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

import { useSessionListStore } from '../stores/session-list.js';
import { useSessionRunStore } from '../stores/session-run.js';
import { updateListedSessionActivity, useChatSessionController } from './useChatSessionController.js';

const directOrigin = {
  type: 'direct',
  id: null,
  display_name: '直接对话',
  channel: 'web',
};

test('message activity only patches an existing complete list projection', () => {
  setActivePinia(createPinia());
  const store = useSessionListStore();
  store.upsert({
    session_id: 'session-a',
    title: '服务端标题',
    first_message: '首条消息',
    last_message: '旧消息',
    activity_at: '2026-07-25T10:00:00.000Z',
    unread_count: 4,
    origin: directOrigin,
    workspace: null,
  });

  updateListedSessionActivity(store, 'session-a', '最新消息', '2026-07-26T10:00:00.000Z');
  updateListedSessionActivity(store, 'session-not-loaded', '不应生成条目', '2026-07-27T10:00:00.000Z');

  assert.deepEqual(store.items.map(item => item.session_id), ['session-a']);
  assert.equal(store.items[0].title, '服务端标题');
  assert.equal(store.items[0].first_message, '首条消息');
  assert.equal(store.items[0].last_message, '最新消息');
  assert.equal(store.items[0].activity_at, '2026-07-26T10:00:00.000Z');
  assert.equal(store.items[0].unread_count, 0);
});

test('late session detail cannot continue an obsolete route switch', async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  });
  const app = createApp({ template: '<div />' });
  app.use(pinia);
  app.use(router);
  const pending = new Map();
  const chatSdkClient = {
    getSession(sessionId) {
      return new Promise((resolve) => { pending.set(sessionId, resolve); });
    },
  };
  const calls = [];
  const deps = {
    sessionFiles: ref([]),
    sessionFilesDrawerVisible: ref(false),
    sessionFilesDrawerTarget: ref('composer'),
    disconnectSessionWS: () => calls.push('disconnect'),
    invalidateActiveStream: () => calls.push('invalidate'),
    clearExecutionState: () => calls.push('clear-execution'),
    clearComposerAttachments: () => calls.push('clear-attachments'),
    loadSessionMessages: async sessionId => {
      calls.push(`messages:${sessionId}`);
      return 37;
    },
    loadSessionFiles: async sessionId => calls.push(`files:${sessionId}`),
    initializeSessionEventCursor: (sessionId, watermark) => calls.push(`cursor:${sessionId}:${watermark}`),
    connectSessionWS: (sessionId, options) => calls.push(`connect:${sessionId}:${options?.historySnapshot === true}`),
    waitForSessionRuntime: async sessionId => calls.push(`runtime:${sessionId}`),
    showToast: () => {},
    chatSdkClient,
  };

    let controller;
    app.runWithContext(() => {
      controller = useChatSessionController(deps);
    });
    const { currentSessionId } = storeToRefs(useSessionRunStore());
    const switchA = controller.syncSessionFromRoute('session-a');
    const switchB = controller.syncSessionFromRoute('session-b');

    const resolveB = pending.get('session-b');
    resolveB({
      data: {
        workspace: { workspace_id: 'workspace-b', display_name: 'B', root_path: 'D:/b' },
        metadata: { team: 'team-b', entry_agent: 'agent-b' },
      },
    });
    await switchB;
    const resolveA = pending.get('session-a');
    resolveA({
      data: {
        workspace: { workspace_id: 'workspace-a', display_name: 'A', root_path: 'D:/a' },
        metadata: { team: 'team-a', entry_agent: 'agent-a' },
      },
    });
    await switchA;

    assert.equal(currentSessionId.value, 'session-b');
    assert.equal(controller.pendingWorkspaceRoot.value, 'D:/b');
    assert.equal(controller.currentSessionTeam.value, 'team-b');
    assert.equal(controller.pendingEntryAgent.value, 'agent-b');
    assert.deepEqual(calls.filter(call => call.includes(':session-')), [
      'messages:session-b',
      'files:session-b',
      'cursor:session-b:37',
      'connect:session-b:true',
      'runtime:session-b',
    ]);
});
