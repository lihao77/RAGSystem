import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

import { useSessionAgentClient } from './useSessionAgentClient.js';
import { useSessionRunStore } from '../stores/session-run.js';
import { createSessionFollowupRecovery } from './sessionFollowupRecovery.js';

test('late transport timeout cannot remove a durably accepted followup or offer duplicate retry', async t => {
  const { deps, sessionRunStore, calls } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  let rejectSend;
  let requestId;
  deps.chatSdkClient.send = async input => {
    requestId = input.requestId;
    return new Promise((_resolve, reject) => { rejectSend = reject; });
  };
  deps.chatSdkClient.listMessageRequestStatuses = async () => ({ data: { items: [{ request_id: requestId, status: 'queued', content: '补充' }] } });
  const sender = useSessionAgentClient(deps);
  const recovery = createSessionFollowupRecovery({ sdk: deps.chatSdkClient, store: sessionRunStore, loadMessages: async () => {}, showToast: () => {} });
  t.after(() => { sender.dispose(); recovery.dispose(); });
  const sending = sender.send({ content: '补充' });
  await new Promise(resolve => setImmediate(resolve));
  sessionRunStore.markFollowupsUnconfirmed('session-1');
  await recovery.refresh();
  assert.equal(sessionRunStore.currentPendingFollowups[0].status, 'queued');
  rejectSend(new Error('ACK timeout'));
  assert.equal(await sending, true);
  await recovery.refresh();
  assert.equal(sessionRunStore.currentPendingFollowups.length, 1);
  assert.deepEqual(calls.showToast, []);
});

test('remounting on an existing socket reconciles durable failures', async t => {
  const { deps } = createDeps();
  const store = useSessionRunStore();
  store.queueFollowup('session-1', 'request-recover', '补充');
  store.markFollowupsUnconfirmed('session-1');
  deps.chatSdkClient.isConnected = true;
  let queried = false;
  deps.chatSdkClient.listMessageRequestStatuses = async () => {
    queried = true;
    return { data: { items: [{ request_id: 'request-recover', status: 'failed', error: '发送失败' }] } };
  };
  const sender = useSessionAgentClient(deps);
  t.after(() => sender.dispose());
  await sender.connectSessionWS('session-1');
  await Promise.resolve();
  assert.equal(queried, true);
  assert.deepEqual(store.currentPendingFollowups, []);
});

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
    pendingCommands,
    contextUsage,
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

  const sdkListeners = new Map();
  const chatSdkClient = {
    sessionId: 'session-1',
    on(type, listener) {
      const listeners = sdkListeners.get(type) || new Set();
      listeners.add(listener);
      sdkListeners.set(type, listeners);
      return () => listeners.delete(listener);
    },
    async connect(sessionId) { this.sessionId = sessionId; },
    disconnect() { this.sessionId = null; },
    async send(input) {
      calls.wsSend.push({
        payload: {
          task: input.task,
          request_id: input.requestId,
        },
      });
      return { started: true, runId: 'run-1' };
    },
    stop() {},
    async respondInteraction() {},
    async resume() { return true; },
  };

  const deps = {
    currentSessionId,
    inputMessage: ref(''),
    pendingAttachments: ref([]),
    messages,
    isLoading,
    sessionRuntime,
    pendingCommands,
    contextUsage,
    activeRun: sessionRunStore.activeRun,
    ensureSession: async () => deps.currentSessionId.value,
    chatSdkClient,
    getCurrentSelectedLlm: () => 'openai/gpt-test',
    materializeAttachmentsForSend: async (attachments) => {
      calls.materializeAttachmentsForSend.push(attachments);
      return attachments;
    },
    clearComposerAttachments: () => { calls.clearComposerAttachments += 1; },
    stickToBottom: () => { calls.stickToBottom += 1; },
    scrollToBottom: () => {},
    cacheMessages: (...args) => { calls.cacheMessages.push(args); },
    deleteMessageCache: () => {},
    loadSessionMessages: () => {},
    updateRecentSession: (...args) => { calls.updateRecentSession.push(args); },
    showToast: (...args) => { calls.showToast.push(args); },
    resetApprovalState: () => {},
    ...overrides,
  };

  return { deps, calls, sessionRunStore, emitSdkStatus: (status) => {
    for (const listener of sdkListeners.get('status') || []) listener(status);
  } };
}

test('running followup 在 ACK 后保留待处理卡片，不提前写入消息投影', async (t) => {
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
    phase: 'model_streaming',
  });

  const sender = useSessionAgentClient(deps);
  await sender.send({ content: '补充：优先处理 A', attachments: [] });

  assert.equal(deps.messages.value.length, 2);
  assert.equal(deps.pendingCommands.value.length, 0);
  assert.equal(sessionRunStore.currentPendingFollowups.length, 1);
  assert.equal(sessionRunStore.currentPendingFollowups[0].content, '补充：优先处理 A');
  assert.equal(sessionRunStore.currentPendingFollowups[0].status, 'queued');
  assert.equal(deps.isLoading.value, true);
  // 附件登记无条件执行（running followup 与首条消息同权）：空草稿也会调用一次
  // materializeAttachmentsForSend（返回 []），此前 followup 分支直接跳过登记。
  assert.deepEqual(calls.materializeAttachmentsForSend, [[]]);
  assert.equal(calls.wsSend.length, 1);
  assert.equal(calls.wsSend[0].payload.request_id, sessionRunStore.currentPendingFollowups[0].request_id);
});

test('running followup 携带附件时先登记到会话再随排队消息提交', async (t) => {
  installBrowserGlobals(t);
  const sdkCalls = [];
  const sdk = {
    sessionId: 'session-1',
    on: () => () => {},
    connect: async () => {},
    disconnect: () => {},
    send: async (options) => {
      sdkCalls.push(options);
      return { started: true, kind: 'agent_run', runId: 'run-sdk' };
    },
    stop: () => {},
    respondInteraction: async () => {},
    resume: async () => true,
  };
  const { deps, calls, sessionRunStore } = createDeps({
    chatSdkClient: sdk,
    materializeAttachmentsForSend: async (attachments, sessionId) => {
      calls.materializeAttachmentsForSend.push({ attachments, sessionId });
      return attachments.map((attachment, index) => ({ ...attachment, file_id: `file-${index + 1}` }));
    },
  });
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running', {
    allowed_actions: ['send_followup', 'stop_run'],
  }));
  deps.messages.value = [
    { role: 'user', content: '原始任务', metadata: {}, attachments: [] },
    createAssistantMessage({ content: '正在处理', finished: false }),
  ];

  const sender = useSessionAgentClient(deps);
  await sender.send({ content: '补充：用这份数据', attachments: [{ name: 'ocean.nc' }] });

  assert.equal(calls.materializeAttachmentsForSend.length, 1);
  assert.equal(calls.materializeAttachmentsForSend[0].sessionId, 'session-1');
  assert.equal(sdkCalls.length, 1);
  assert.deepEqual(sdkCalls[0].attachments, [{ file_id: 'file-1' }]);
  assert.equal(sessionRunStore.currentPendingFollowups.length, 1);
  assert.equal(sessionRunStore.currentPendingFollowups[0].content, '补充：用这份数据');
  assert.equal(sessionRunStore.currentPendingFollowups[0].status, 'queued');
  assert.equal(calls.clearComposerAttachments, 1);
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
  assert.equal(deps.pendingCommands.value.length, 0);
  assert.equal(sessionRunStore.currentPendingFollowups[0].content, '后台仍在跑时补充');
  assert.equal(deps.isLoading.value, true);
  assert.equal(calls.wsSend.length, 1);
});

test('idle 快照允许普通发送，但服务端确认前消息和 runtime 投影都不变', async (t) => {
  installBrowserGlobals(t);
  const { deps, calls } = createDeps();
  const sender = useSessionAgentClient(deps);
  await sender.send({ content: '执行新任务', attachments: [] });
  sender.clearCommandFallback();

  assert.deepEqual(deps.messages.value, []);
  assert.equal(deps.activeRun.assistantMsgIndex, -1);
  assert.equal(deps.activeRun.runId, null);
  assert.equal(deps.activeRun.active, false);
  assert.equal(deps.isLoading.value, true);
  assert.equal(deps.sessionRuntime.value.state, 'idle');
  assert.equal(deps.pendingCommands.value[0].kind, 'send');
  assert.equal(calls.materializeAttachmentsForSend.length, 1);
  assert.equal(calls.wsSend[0].payload.request_id, deps.pendingCommands.value[0].request_id);
});

test('followup 在 ACK 前显示发送中，消费先于 ACK 时不会重新出现', async () => {
  const { deps, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  let acknowledge;
  let sentInput;
  deps.chatSdkClient.send = async (input) => {
    sentInput = input;
    return new Promise(resolve => { acknowledge = resolve; });
  };
  const sender = useSessionAgentClient(deps);
  const sending = sender.send({ content: '请先检查错误日志' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sessionRunStore.currentPendingFollowups[0].status, 'sending');
  assert.equal(sessionRunStore.currentPendingFollowups[0].content, '请先检查错误日志');
  sender.handleEnvelope({ type: 'agent_message', run_id: 'run-1', payload: {
    message_id: 'consumed-1', content: sentInput.task,
    metadata: { mailbox_message_id: 'consumed-1', consumed_by_run_id: 'run-1', request_id: sentInput.requestId },
  } }, 'session-1');
  assert.equal(sessionRunStore.currentPendingFollowups.length, 0);
  assert.equal(deps.messages.value[0].content, '请先检查错误日志');
  acknowledge({ started: true });
  assert.equal(await sending, true);
  assert.equal(sessionRunStore.currentPendingFollowups.length, 0);
  assert.equal(deps.pendingCommands.value.length, 0);
});

test('多个 followup 按 request_id 独立确认，失败或异步错误不会留下卡片或忙状态', async () => {
  const { deps, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  const sender = useSessionAgentClient(deps);
  await sender.send({ content: '补充一' });
  await sender.send({ content: '补充二' });
  const [first, second] = sessionRunStore.currentPendingFollowups;
  sender.handleEnvelope({ type: 'state_sync', run_id: 'run-1', payload: { category: 'message_saved', ref: {
    role: 'user', message_id: 'm2', content_parts: [{ type: 'text', text: '补充二' }],
    metadata: { request_id: second.request_id },
  } } }, 'session-1');
  assert.deepEqual(sessionRunStore.currentPendingFollowups.map(item => item.content), ['补充一']);
  sender.handleEnvelope({ type: 'error', payload: { request_id: first.request_id, message: '发送失败' } }, 'session-1');
  sessionRunStore.applySessionRuntime(runtimeSnapshot('idle'));
  assert.equal(sessionRunStore.currentPendingFollowups.length, 0);
  assert.equal(deps.isLoading.value, false);

  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  deps.chatSdkClient.send = async () => { throw new Error('连接断开'); };
  assert.equal(await sender.send({ content: '失败的补充' }), false);
  assert.equal(sessionRunStore.currentPendingFollowups.length, 0);
  assert.equal(deps.pendingCommands.value.length, 0);
});

test('断线前已发送的 followup 保留原文，迟到 ACK 不把状态待确认改回排队', async () => {
  const { deps, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  let acknowledge;
  deps.chatSdkClient.send = () => new Promise(resolve => { acknowledge = resolve; });
  const sender = useSessionAgentClient(deps);
  const sending = sender.send({ content: '请核对原始记录' });
  await new Promise(resolve => setImmediate(resolve));
  const requestId = sessionRunStore.currentPendingFollowups[0].request_id;
  sender.disconnectSessionWS();
  deps.currentSessionId.value = 'session-2';
  acknowledge({ started: true });
  assert.equal(await sending, true);
  deps.currentSessionId.value = 'session-1';
  assert.deepEqual(sessionRunStore.currentPendingFollowups.map(item => [item.content, item.status]), [
    ['请核对原始记录', 'unconfirmed'],
  ]);
  sessionRunStore.reconcilePendingFollowups('session-1', [{
    role: 'user', id: 'consumed', metadata: { request_id: requestId },
  }]);
  assert.equal(sessionRunStore.currentPendingFollowups.length, 0);
  sender.dispose();
});

test('连接状态变化和视图销毁均标记已 ACK 的 followup 为待确认', async () => {
  for (const action of ['reconnecting', 'disconnected', 'dispose']) {
    const { deps, sessionRunStore, emitSdkStatus } = createDeps();
    sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
    const sender = useSessionAgentClient(deps);
    await sender.send({ content: '保留这条补充' });
    if (action === 'dispose') sender.dispose();
    else emitSdkStatus({ state: action });
    assert.equal(sessionRunStore.currentPendingFollowups[0].status, 'unconfirmed', action);
    emitSdkStatus({ state: 'connected' });
    assert.equal(sessionRunStore.currentPendingFollowups[0].status, 'unconfirmed', action);
    sender.dispose();
  }
});

test('断线导致 SDK 返回发送失败时保留未确认消息，不提供自动重试', async () => {
  const { deps, calls, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  let failSend;
  deps.chatSdkClient.send = () => new Promise(resolve => { failSend = resolve; });
  const sender = useSessionAgentClient(deps);
  const sending = sender.send({ content: '可能已经收到了' });
  await new Promise(resolve => setImmediate(resolve));
  sender.disconnectSessionWS();
  failSend({ started: false, error: '连接已断开' });
  assert.equal(await sending, false);
  assert.deepEqual(sessionRunStore.currentPendingFollowups.map(item => [item.content, item.status]), [
    ['可能已经收到了', 'unconfirmed'],
  ]);
  assert.equal(deps.pendingCommands.value.length, 0);
  assert.deepEqual(calls.showToast.at(-1), ['连接中断，补充消息状态待确认', 'warning']);
  sender.dispose();
});

test('非当前会话的迟到失败和消费事实只清除对应请求，不串入当前聊天', () => {
  const completions = [
    { type: 'ack', payload: { category: 'send', ok: false, request_id: 'request-1' } },
    { type: 'error', payload: { request_id: 'request-1', message: '异步失败' } },
    { type: 'agent_message', run_id: 'run-1', payload: {
      message_id: 'm1', content: '已消费',
      metadata: { mailbox_message_id: 'm1', request_id: 'request-1' },
    } },
    { type: 'state_sync', payload: { category: 'message_saved', ref: {
      role: 'user', message_id: 'm1', metadata: { request_id: 'request-1' },
    } } },
  ];
  for (const event of completions) {
    const { deps, calls, sessionRunStore } = createDeps();
    const sender = useSessionAgentClient(deps);
    sessionRunStore.queueFollowup('session-1', 'request-1', '会话一已确认的补充');
    sessionRunStore.queueFollowup('session-1', 'request-2', '会话一仍待确认的补充');
    sessionRunStore.queueFollowup('session-2', 'request-1', '会话二同名请求');
    deps.currentSessionId.value = 'session-2';
    sender.handleEnvelope(event, 'session-1');
    assert.deepEqual(sessionRunStore.pendingFollowups.map(item => [item.session_id, item.request_id]), [
      ['session-1', 'request-2'], ['session-2', 'request-1'],
    ], event.type);
    assert.deepEqual(deps.messages.value, [], event.type);
    assert.deepEqual(calls.showToast, [], event.type);
    assert.deepEqual(calls.updateRecentSession, [], event.type);
    sender.dispose();
  }
});

test('运行快照到达前不会把连续发送擅自升级为 followup', async (t) => {
  installBrowserGlobals(t);
  const { deps, calls } = createDeps();
  const sender = useSessionAgentClient(deps);

  const first = sender.send({ content: '第一条', attachments: [] });
  const second = sender.send({ content: '第二条', attachments: [] });
  await Promise.all([first, second]);
  sender.clearCommandFallback();

  assert.deepEqual(deps.messages.value, []);
  assert.equal(deps.pendingCommands.value.length, 1);
  assert.deepEqual(calls.wsSend.map(event => event.payload.task), ['第一条']);
});

test('注入 chat SDK 后发送由 SDK 接管并保留 requestId、LLM 与附件', async (t) => {
  installBrowserGlobals(t);
  const sdkCalls = [];
  const sdk = {
    sessionId: 'session-1',
    on: () => () => {},
    connect: async () => {},
    disconnect: () => {},
    send: async (options) => {
      sdkCalls.push(options);
      return { started: true, kind: 'agent_run', runId: 'run-sdk' };
    },
    stop: () => {},
    respondInteraction: async () => {},
    resume: async () => true,
  };
  const { deps, calls } = createDeps({ chatSdkClient: sdk });
  const sender = useSessionAgentClient(deps);

  await sender.send({ content: '通过 SDK 发送', attachments: [{ file_id: 'file-1' }] });

  assert.equal(calls.wsSend.length, 0);
  assert.equal(sdkCalls.length, 1);
  assert.equal(sdkCalls[0].task, '通过 SDK 发送');
  assert.equal(sdkCalls[0].selectedLlm, 'openai/gpt-test');
  assert.deepEqual(sdkCalls[0].attachments, [{ file_id: 'file-1' }]);
  assert.equal(sdkCalls[0].requestId, deps.pendingCommands.value[0].request_id);
  assert.equal(deps.activeRun.runId, null);
  assert.deepEqual(deps.messages.value, []);
});
