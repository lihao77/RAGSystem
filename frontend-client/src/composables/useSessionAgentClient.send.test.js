import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

import { useSessionAgentClient } from './useSessionAgentClient.js';
import { useSessionRunStore } from '../stores/session-run.js';

function createAssistantMessage(overrides = {}) {
  return {
    role: 'assistant',
    content: '',
    status: [],
    subtasks: [],
    finished: false,
    metadata: {},
    ...overrides,
  };
}

function runtimeSnapshot(state, overrides = {}) {
  const active = ['running', 'waiting_interaction', 'suspended', 'resuming'].includes(state);
  const strategies = {
    idle: 'history',
    running: 'attach_run',
    waiting_interaction: 'attach_run_and_present_interactions',
    suspended: 'restore_suspended_run_and_present_interactions',
    resuming: 'attach_resume',
    maintenance: 'watch_maintenance',
  };
  return {
    state,
    load_strategy: strategies[state],
    allowed_actions: state === 'idle'
      ? ['send_message', 'start_maintenance']
      : state === 'running' ? ['send_followup', 'stop_run'] : [],
    active_run: active ? {
      run_id: 'run-1',
      status: state,
      execution_owner: state === 'suspended' ? 'detached' : 'attached',
      task: 'task',
      request_id: 'req-1',
      execution_kind: 'agent_stream',
      started_at: '2026-07-30T00:00:00.000Z',
      updated_at: '2026-07-30T00:00:01.000Z',
    } : null,
    last_run: null,
    pending_interactions: [],
    resume_interaction_id: null,
    maintenance: state === 'maintenance'
      ? { kind: 'rollback', expires_at: '2026-07-30T00:01:00.000Z' }
      : null,
    observed_at: '2026-07-30T00:00:01.000Z',
    ...overrides,
  };
}

function installBrowserGlobals(t) {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });
}

function createDeps(overrides = {}) {
  setActivePinia(createPinia());
  const sessionRunStore = useSessionRunStore();
  const {
    currentSessionId,
    messages,
    isLoading,
    sessionRuntime,
    optimisticCommand,
    contextUsage,
    pendingFollowupCandidates,
  } = storeToRefs(sessionRunStore);
  currentSessionId.value = 'session-1';
  sessionRunStore.applySessionRuntime(runtimeSnapshot('idle'));

  const calls = {
    wsSend: [],
    materializeAttachmentsForSend: [],
    clearComposerAttachments: 0,
    stickToBottom: 0,
    cacheMessages: [],
    updateRecentSession: [],
    showToast: [],
  };

  const ws = {
    readyState: 1,
    send: raw => calls.wsSend.push(JSON.parse(raw)),
  };

  const deps = {
    currentSessionId,
    inputMessage: ref(''),
    pendingAttachments: ref([]),
    messages,
    isLoading,
    sessionRuntime,
    optimisticCommand,
    contextUsage,
    pendingFollowupCandidates,
    activeRun: sessionRunStore.activeRun,
    ensureSession: async () => deps.currentSessionId.value,
    getWS: () => ws,
    getCurrentSelectedLlm: () => 'openai/gpt-test',
    materializeAttachmentsForSend: async (attachments) => {
      calls.materializeAttachmentsForSend.push(attachments);
      return attachments;
    },
    clearComposerAttachments: () => { calls.clearComposerAttachments += 1; },
    stickToBottom: () => { calls.stickToBottom += 1; },
    cacheMessages: (...args) => { calls.cacheMessages.push(args); },
    deleteMessageCache: () => {},
    loadSessionMessages: () => {},
    updateRecentSession: (...args) => { calls.updateRecentSession.push(args); },
    showToast: (...args) => { calls.showToast.push(args); },
    resetApprovalState: () => {},
    ...overrides,
  };

  return { deps, calls, sessionRunStore };
}

test('running 快照允许发送 followup，并等待服务端确认后再进入消息投影', async (t) => {
  installBrowserGlobals(t);
  const assistant = createAssistantMessage({ content: '正在处理', finished: false });
  const { deps, calls, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running', {
    allowed_actions: ['send_followup', 'stop_run'],
  }));
  deps.messages.value = [
    { role: 'user', content: '原始任务', metadata: {}, attachments: [] },
    assistant,
  ];
  Object.assign(deps.activeRun, {
    assistantMsgIndex: 1,
    runId: 'run-1',
    phase: 'llm_streaming',
  });

  const sender = useSessionAgentClient(deps);
  await sender.send({ content: '补充：优先处理 A', attachments: [] });

  assert.equal(deps.messages.value.length, 2);
  assert.equal(deps.pendingFollowupCandidates.value.length, 1);
  const candidate = deps.pendingFollowupCandidates.value[0];
  assert.equal(candidate.content, '补充：优先处理 A');
  assert.equal(candidate.metadata.execution_kind, 'session_followup');
  assert.equal(candidate.metadata.run_id, 'run-1');
  assert.equal(candidate.metadata.persistence_status, 'pending');
  assert.equal(deps.isLoading.value, true);
  assert.deepEqual(calls.materializeAttachmentsForSend, []);
  assert.equal(calls.wsSend.length, 1);
  assert.equal(calls.wsSend[0].payload.request_id, candidate.metadata.request_id);
});

test('followup 只依赖权威 runtime，即使本地 activeRun 投影丢失仍绑定服务端 run', async (t) => {
  installBrowserGlobals(t);
  const { deps, calls, sessionRunStore } = createDeps();
  const running = runtimeSnapshot('running', {
    allowed_actions: ['send_followup'],
  });
  running.active_run.run_id = 'run-from-runtime';
  sessionRunStore.applySessionRuntime(running);
  deps.messages.value = [
    { role: 'user', content: '原始任务', metadata: {}, attachments: [] },
    createAssistantMessage({ content: '已有输出', finished: false }),
  ];
  Object.assign(deps.activeRun, { active: false, assistantMsgIndex: -1, runId: null });

  const sender = useSessionAgentClient(deps);
  await sender.send({ content: '后台仍在跑时补充', attachments: [] });

  assert.equal(deps.messages.value.length, 2);
  assert.equal(deps.pendingFollowupCandidates.value.length, 1);
  const candidate = deps.pendingFollowupCandidates.value[0];
  assert.equal(candidate.metadata.run_id, 'run-from-runtime');
  assert.equal(deps.isLoading.value, true);
  assert.equal(calls.wsSend.length, 1);
});

test('idle 快照允许普通发送，并只创建乐观命令而不伪造 runtime 状态', async (t) => {
  installBrowserGlobals(t);
  const { deps, calls } = createDeps();
  const sender = useSessionAgentClient(deps);
  await sender.send({ content: '执行新任务', attachments: [] });
  sender.clearCommandFallback();

  assert.deepEqual(deps.messages.value.map(message => message.role), ['user', 'assistant']);
  assert.equal(deps.messages.value[0].metadata.execution_kind, 'agent_stream');
  assert.equal(deps.activeRun.assistantMsgIndex, 1);
  assert.equal(deps.isLoading.value, true);
  assert.equal(deps.sessionRuntime.value.state, 'idle');
  assert.equal(deps.optimisticCommand.value.kind, 'send');
  assert.equal(calls.materializeAttachmentsForSend.length, 1);
  assert.equal(calls.wsSend[0].payload.request_id, deps.messages.value[0].metadata.request_id);
});

test('运行快照到达前不会把连续发送擅自升级为 followup', async (t) => {
  installBrowserGlobals(t);
  const { deps, calls } = createDeps();
  const sender = useSessionAgentClient(deps);

  const first = sender.send({ content: '第一条', attachments: [] });
  const second = sender.send({ content: '第二条', attachments: [] });
  await Promise.all([first, second]);
  sender.clearCommandFallback();

  assert.deepEqual(deps.messages.value.map(message => [message.role, message.content]), [
    ['user', '第一条'],
    ['assistant', ''],
  ]);
  assert.equal(deps.pendingFollowupCandidates.value.length, 0);
  assert.deepEqual(calls.wsSend.map(event => event.payload.task), ['第一条']);
});
