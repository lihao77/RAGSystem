import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, ref } from 'vue';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import MockAdapter from 'axios-mock-adapter';

import { httpClient } from '../api/http.js';
import { useSessionListStore } from '../stores/session-list.js';
import { useSessionRunStore } from '../stores/session-run.js';
import { useLlmStore } from '../stores/llm.js';
import { useThinkingStore } from '../stores/thinking.js';
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
        team_name: 'team-b', entry_agent_name: 'agent-b', metadata: {},
      },
    });
    await switchB;
    const resolveA = pending.get('session-a');
    resolveA({
      data: {
        workspace: { workspace_id: 'workspace-a', display_name: 'A', root_path: 'D:/a' },
        team_name: 'team-a', entry_agent_name: 'agent-a', metadata: {},
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

test('creating a new session carries the selected default permission mode', async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }, { path: '/chat/:sessionId', component: { template: '<div />' } }],
  });
  const app = createApp({ template: '<div />' });
  app.use(pinia);
  app.use(router);
  const bodies = [];
  const deps = {
    sessionFiles: ref([]),
    sessionFilesDrawerVisible: ref(false),
    sessionFilesDrawerTarget: ref('composer'),
    connectSessionWS: () => {},
    disconnectSessionWS: () => {},
    invalidateActiveStream: () => {},
    clearExecutionState: () => {},
    clearComposerAttachments: () => {},
    loadSessionFiles: async () => {},
    loadSessionParticipants: async () => {},
    showToast: () => {},
    chatSdkClient: {
      createSession: async body => {
        bodies.push(body);
        return { data: {
          session_id: 'session-new',
          origin: directOrigin,
          workspace: null,
          team_name: 'team-a',
          entry_agent_name: 'agent-a',
        } };
      },
    },
  };
  const controller = app.runWithContext(() => useChatSessionController(deps));
  controller.currentSessionTeam.value = 'team-a';
  localStorage.setItem('ragsystem:chat-default-permission-mode', 'relaxed');

  await controller.ensureSession({ replaceRoute: true });

  assert.equal(bodies[0].permission_mode, 'relaxed');
  localStorage.removeItem('ragsystem:chat-default-permission-mode');
});


test('selecting model or thinking level persists to the active session immediately', async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  });
  const app = createApp({ template: '<div />' });
  app.use(pinia);
  app.use(router);
  const persisted = [];
  const deps = {
    sessionFiles: ref([]),
    sessionFilesDrawerVisible: ref(false),
    sessionFilesDrawerTarget: ref('composer'),
    disconnectSessionWS: () => {},
    invalidateActiveStream: () => {},
    clearExecutionState: () => {},
    clearComposerAttachments: () => {},
    loadSessionFiles: async () => {},
    loadSessionParticipants: async () => {},
    showToast: () => {},
    persistRequestOverrides: async (sessionId, overrides) => {
      persisted.push({ sessionId, overrides });
    },
  };
  let controller;
  app.runWithContext(() => {
    controller = useChatSessionController(deps);
  });

  const sessionRunStore = useSessionRunStore();
  const llmStore = useLlmStore();
  const thinkingStore = useThinkingStore();

  // 无激活会话（新会话）：选择只进全局默认，不触发落库
  llmStore.setSelectedLLM('p1|openai|m1');
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(persisted.length, 0);

  // 激活会话后选择：合并写出当前生效的模型+档位对
  sessionRunStore.currentSessionId = 'session-x';
  thinkingStore.setThinkingLevel('high');
  llmStore.setSelectedLLM('p2|openai|m2');
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0], {
    sessionId: 'session-x',
    overrides: { selectedLLM: 'p2|openai|m2', thinkingLevel: 'high' },
  });

  // 恢复/清覆盖不是用户选择，不触发落库
  llmStore.applySessionOverride('session-x', 'p1|openai|m1');
  thinkingStore.applySessionOverride('session-x', 'max');
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(persisted.length, 1);
  assert.equal(controller.currentSessionTeam.value, '');
});


test('hydrate restores validated request overrides into the session override layer', async () => {
  localStorage.clear();
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }, { path: '/chat/:sessionId', component: { template: '<div />' } }],
  });
  const app = createApp({ template: '<div />' });
  app.use(pinia);
  app.use(router);
  const mock = new MockAdapter(httpClient);
  mock.onGet('/api/model-adapter/providers').reply(200, {
    success: true,
    providers: [{
      key: 'ali_alibaba',
      name: 'ali',
      // 思考 descriptor 按模型条目注入（后端 describeThinking 显式定形：effort + 子集收缩）
      models: [{ name: 'deepseek-v4-flash', thinking: { kind: 'effort', levels: ['off', 'high', 'max'] } }],
    }],
  });
  const chatSdkClient = {
    getSession: async () => ({
      data: {
        workspace: null,
        team_name: 'team-a',
        entry_agent_name: 'agent-a',
        metadata: {
          _request_overrides: { selected_llm: 'ali|alibaba|deepseek-v4-flash', thinking_level: 'high' },
        },
      },
    }),
  };
  const deps = {
    sessionFiles: ref([]),
    sessionFilesDrawerVisible: ref(false),
    sessionFilesDrawerTarget: ref('composer'),
    disconnectSessionWS: () => {},
    invalidateActiveStream: () => {},
    clearExecutionState: () => {},
    clearComposerAttachments: () => {},
    loadSessionMessages: async () => 0,
    loadSessionFiles: async () => {},
    loadSessionParticipants: async () => {},
    initializeSessionEventCursor: () => {},
    connectSessionWS: async () => {},
    waitForSessionRuntime: async () => {},
    showToast: () => {},
    chatSdkClient,
  };
  let controller;
  app.runWithContext(() => {
    controller = useChatSessionController(deps);
  });

  await controller.syncSessionFromRoute('session-r');

  const llmStore = useLlmStore();
  const thinkingStore = useThinkingStore();
  assert.equal(llmStore.selectedLLM, 'ali|alibaba|deepseek-v4-flash');
  assert.equal(thinkingStore.thinkingLevel, 'high');
  assert.equal(controller.currentSessionTeam.value, 'team-a');

  // 切走（新会话）后覆盖层失活，回落个人默认
  await controller.syncSessionFromRoute(null);
  assert.equal(llmStore.selectedLLM, '');
  assert.equal(thinkingStore.thinkingLevel, '');
  mock.restore();
});

test('hydrate restores default-model thinking level through defaultLlm resolution', async () => {
  localStorage.clear();
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }, { path: '/chat/:sessionId', component: { template: '<div />' } }],
  });
  const app = createApp({ template: '<div />' });
  app.use(pinia);
  app.use(router);
  const mock = new MockAdapter(httpClient);
  mock.onGet('/api/model-adapter/providers').reply(200, {
    success: true,
    providers: [{
      key: 'ali_alibaba',
      name: 'ali',
      // 思考 descriptor 按模型条目注入（后端 describeThinking 显式定形：effort + 子集收缩）
      models: [{ name: 'deepseek-v4-flash', thinking: { kind: 'effort', levels: ['off', 'high', 'max'] } }],
    }],
  });
  const chatSdkClient = {
    getSession: async () => ({
      data: {
        workspace: null,
        team_name: 'team-a',
        entry_agent_name: 'agent-a',
        metadata: {
          // "默认模型 + 档位"记录：selected_llm 为空，档位按默认生效模型校验
          _request_overrides: { selected_llm: null, thinking_level: 'high' },
        },
      },
    }),
  };
  const deps = {
    sessionFiles: ref([]),
    sessionFilesDrawerVisible: ref(false),
    sessionFilesDrawerTarget: ref('composer'),
    disconnectSessionWS: () => {},
    invalidateActiveStream: () => {},
    clearExecutionState: () => {},
    clearComposerAttachments: () => {},
    loadSessionMessages: async () => 0,
    loadSessionFiles: async () => {},
    loadSessionParticipants: async () => {},
    initializeSessionEventCursor: () => {},
    connectSessionWS: async () => {},
    waitForSessionRuntime: async () => {},
    showToast: () => {},
    chatSdkClient,
    fetchDefaultLlm: async (teamName, agentName) => {
      if (teamName !== 'team-a') throw new Error(`unexpected team: ${teamName}`);
      if (agentName !== 'agent-a') throw new Error(`unexpected agent: ${agentName}`);
      return { provider: 'ali', provider_type: 'alibaba', model: 'deepseek-v4-flash' };
    },
  };
  let controller;
  app.runWithContext(() => {
    controller = useChatSessionController(deps);
  });

  await controller.syncSessionFromRoute('session-d');

  const llmStore = useLlmStore();
  const thinkingStore = useThinkingStore();
  // 模型保持默认（空串），档位恢复为会话记录值
  assert.equal(llmStore.selectedLLM, '');
  assert.equal(thinkingStore.thinkingLevel, 'high');
  mock.restore();
});
