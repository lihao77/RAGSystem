import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, ref } from 'vue';
import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

import { useMessageRevision } from './useMessageRevision.js';
import { useSessionRunStore } from '../stores/session-run.js';
import { httpClient } from '../api/http.js';

function createDeps(overrides = {}) {
  setActivePinia(createPinia());
  const sessionRunStore = useSessionRunStore();
  const { messages, currentSessionId } = storeToRefs(sessionRunStore);
  currentSessionId.value = 'session-1';
  const sessionFilesDrawerVisible = ref(false);
  const sessionFilesDrawerTarget = ref('composer');
  const toasts = [];
  const cacheCalls = [];
  const materializeCalls = [];
  const reloadCalls = [];
  const participantReloadCalls = [];
  const cacheDeleteCalls = [];
  const activeRun = sessionRunStore.activeRun;
  sessionRunStore.applySessionRuntime({
    state: 'idle',
    load_strategy: 'history',
    allowed_actions: ['send_message', 'start_maintenance'],
    active_run: null,
    last_run: null,
    pending_interactions: [],
    resume_interaction_id: null,
    maintenance: null,
    observed_at: '2026-07-30T00:00:00.000Z',
  });

  const deps = {
    messages,
    currentSessionId,
    sessionFilesDrawerVisible,
    sessionFilesDrawerTarget,
    normalizeAttachment: (file) => (file ? { ...file, file_id: file.file_id || file.id } : null),
    showToast: (message) => toasts.push(message),
    cacheMessages: (...args) => cacheCalls.push(args),
    activeRun,
    materializeAttachmentsForSend: async (attachments) => { materializeCalls.push(attachments); return attachments; },
    reloadSessionMessages: async (sessionId) => { reloadCalls.push(sessionId); },
    reloadSessionParticipants: async (sessionId) => { participantReloadCalls.push(sessionId); },
    deleteMessageCache: (sessionId) => { cacheDeleteCalls.push(sessionId); },
    getCurrentSelectedLlm: () => null,
    stickToBottom: () => {},
    chatSdkClient: {
      rollbackAndRetrySession: (sessionId, body) => httpClient.post(
        `/api/agent/sessions/${encodeURIComponent(sessionId)}/rollback-and-retry`,
        body,
      ),
    },
    ...overrides,
  };

  return {
    deps,
    toasts,
    cacheCalls,
    materializeCalls,
    reloadCalls,
    participantReloadCalls,
    cacheDeleteCalls,
    activeRun,
    sessionRunStore,
  };
}

function withMock(setup, run) {
  const mock = new MockAdapter(httpClient);
  setup(mock);
  return Promise.resolve()
    .then(run)
    .finally(() => { mock.restore(); });
}

test('confirmEditAndResend 锚定旧消息并将编辑内容交给统一发送入口', async () => {
  let capturedBody = null;
  let capturedOptions = null;
  const canonicalMessages = [
    { role: 'user', id: 'msg-1', content: 'first' },
    { role: 'user', id: 'msg-new', seq: 2, content: 'updated', metadata: { request_id: 'req-new' } },
  ];
  {
    const attachment = { id: 'file-2', original_name: 'draft.txt', mime: 'text/plain', size: 12 };
    const {
      deps,
      participantReloadCalls,
      cacheDeleteCalls,
      sessionRunStore,
    } = createDeps({
      chatSdkClient: {
        rollbackAndRetrySession: async (_sessionId, body, options) => {
          capturedBody = body;
          capturedOptions = options;
          assert.deepEqual(deps.messages.value.map(item => item.id), ['msg-1', 'msg-2', 'msg-3']);
          return { data: { started: true, request_id: options.requestId, run_id: 'run-new' } };
        },
      },
      reloadSessionMessages: async (sessionId, options) => {
        assert.equal(sessionId, 'session-1');
        assert.deepEqual(options, { preserveStream: true });
        deps.messages.value = canonicalMessages;
      },
    });
    deps.messages.value = [
      { role: 'user', id: 'msg-1', content: 'first' },
      { role: 'user', id: 'msg-2', content: 'draft', attachments: [attachment] },
      { role: 'assistant', id: 'msg-3', content: 'old reply', finished: true },
    ];

    const revision = useMessageRevision(deps);
    revision.startEditMessage(deps.messages.value[1], 1);
    revision.editingDraft.value = ' updated ';

    await revision.confirmEditAndResend();

    // 锚点指向被编辑消息本身（msg-2），不是前一条；透传 modify_user_message 与附件
    assert.equal(capturedBody.after_message_id, 'msg-2');
    assert.equal(capturedBody.modify_user_message, 'updated');
    assert.equal(capturedBody.attachments[0].file_id, 'file-2');
    assert.equal(typeof capturedOptions.requestId, 'string');
    assert.deepEqual(deps.messages.value, canonicalMessages);
    assert.equal(sessionRunStore.activeRun.active, false);
    assert.equal(sessionRunStore.activeRun.runId, null);
    assert.deepEqual(sessionRunStore.pendingCommands, []);
    assert.deepEqual(participantReloadCalls, ['session-1']);
    assert.deepEqual(cacheDeleteCalls, ['session-1']);
    assert.equal(revision.editingMessage.value, null);
  }
});

test('命令路径（/compact）HTTP 未返回时，新消息被接受即关编辑框并重载，不卡"提交中"', async () => {
  let resolveRequest = null;
  const { deps, reloadCalls, sessionRunStore } = createDeps({
    chatSdkClient: {
      rollbackAndRetrySession: () => new Promise((resolve) => { resolveRequest = resolve; }),
    },
  });
  deps.messages.value = [
    { role: 'user', id: 'msg-1', seq: 1, content: 'first' },
    { role: 'user', id: 'msg-2', seq: 2, content: 'draft' },
  ];
  const revision = useMessageRevision(deps);
  revision.startEditMessage(deps.messages.value[1]);
  revision.editingDraft.value = '/compact';

  const pending = revision.confirmEditAndResend();
  // confirmEditAndResend 在首个 await（附件物化）后才 beginPendingCommand，先等一拍再取。
  await nextTick();
  const requestId = sessionRunStore.pendingCommands[0]?.request_id;
  assert.equal(typeof requestId, 'string');

  // 模拟 dispatcher：message_saved（携带 request_id）到达 → finishPendingCommand 移除本项。
  // 此时 HTTP 仍未返回（/compact 在请求内跑数十秒），编辑框应立即收尾并重载权威视图。
  sessionRunStore.finishPendingCommand(requestId);
  await nextTick();
  await nextTick();

  assert.equal(revision.editingMessage.value, null);
  assert.equal(revision.editingSubmitting.value, false);
  assert.deepEqual(reloadCalls, ['session-1']);
  assert.equal(sessionRunStore.isLoading, false);

  resolveRequest({ data: { started: true } });
  await pending;
  // 响应返回后不重复重载。
  assert.deepEqual(reloadCalls, ['session-1']);
});

test('rollbackAndRetry 失败时重新加载服务端消息并提示错误', async () => {
  {
    const serverMessages = [{ role: 'user', seq: 1, id: 'msg-server', content: 'server state' }];
    const {
      deps,
      toasts,
      reloadCalls,
      participantReloadCalls,
      cacheDeleteCalls,
      sessionRunStore,
    } = createDeps({
      chatSdkClient: {
        rollbackAndRetrySession: async () => { throw new Error('重试失败啦'); },
      },
      reloadSessionMessages: async (sessionId, options) => {
        reloadCalls.push(sessionId);
        assert.deepEqual(options, { preserveStream: true });
        deps.messages.value = serverMessages;
      },
    });
    const originalMessages = [
      { role: 'user', seq: 1, id: 'msg-1', content: 'question' },
      { role: 'assistant', seq: 2, id: 'msg-2', content: 'answer', finished: true },
    ];
    deps.messages.value = originalMessages;
    sessionRunStore.setParticipantMessages('child-1', [
      { role: 'assistant', id: 'child-old', content: 'stale child state' },
    ]);

    const revision = useMessageRevision(deps);
    await revision.rollbackAndRetry(deps.messages.value[0]);

    assert.deepEqual(deps.messages.value, serverMessages);
    assert.deepEqual(reloadCalls, ['session-1']);
    assert.deepEqual(participantReloadCalls, ['session-1']);
    assert.deepEqual(cacheDeleteCalls, ['session-1']);
    assert.deepEqual(Object.keys(sessionRunStore.participantMessages), ['root']);
    assert.deepEqual(toasts, ['重试失败啦']);
    assert.deepEqual(sessionRunStore.pendingCommands, []);
    assert.equal(sessionRunStore.isLoading, false);
  }
});

test('回滚接口返回前已收到流式事件时保留执行树投影', async () => {
  let streamedAssistant = null;
  const { deps, activeRun, sessionRunStore } = createDeps({
    chatSdkClient: {
      rollbackAndRetrySession: async (_sessionId, _body, options) => {
        assert.deepEqual(deps.messages.value.map(item => item.id), ['msg-1', 'msg-2']);
        streamedAssistant = { role: 'assistant', content: 'partial output', run_id: 'run-retry', finished: false };
        streamedAssistant.content = 'partial output';
        streamedAssistant.executionTree = {
          root: { callId: 'call-root', status: 'running' },
        };
        deps.messages.value = [
          { role: 'user', id: 'msg-retry', seq: 1, content: 'question', metadata: { request_id: options.requestId } },
          { role: 'system', content: 'summary' },
          streamedAssistant,
        ];
        Object.assign(activeRun, { active: true, assistantMsgIndex: 2, runId: 'run-retry' });
        return {
          data: {
            started: true,
            request_id: 'req-retry',
            run_id: 'run-retry',
          },
        };
      },
    },
    reloadSessionMessages: async (_sessionId, options) => {
      assert.deepEqual(options, { preserveStream: true });
    },
  });
  deps.messages.value = [
    { role: 'user', id: 'msg-1', seq: 1, content: 'question' },
    { role: 'assistant', id: 'msg-2', seq: 2, content: 'old answer', finished: true },
  ];

  const revision = useMessageRevision(deps);
  await revision.rollbackAndRetry(deps.messages.value[0]);

  assert.ok(streamedAssistant);
  const projectedAssistant = deps.messages.value.at(-1);
  assert.equal(projectedAssistant.content, 'partial output');
  assert.deepEqual(projectedAssistant.executionTree.root, { callId: 'call-root', status: 'running' });
  assert.equal(projectedAssistant.run_id, 'run-retry');
  assert.equal(activeRun.runId, 'run-retry');
  assert.equal(activeRun.active, true);
  assert.deepEqual(sessionRunStore.pendingCommands, []);
});

test('回滚 run 在接口响应前结束时不会重新进入 loading', async () => {
  const { deps, activeRun, sessionRunStore } = createDeps({
    chatSdkClient: {
      rollbackAndRetrySession: async (_sessionId, _body, options) => {
        deps.messages.value = [{
          role: 'assistant',
          id: 'assistant-done',
          run_id: 'run-done',
          content: 'done',
          finished: true,
        }];
        sessionRunStore.finishPendingCommand(options.requestId);
        return { data: { started: true, run_id: 'run-done' } };
      },
    },
    reloadSessionMessages: async () => {},
  });
  deps.messages.value = [{ role: 'user', id: 'msg-1', seq: 1, content: 'question' }];

  const revision = useMessageRevision(deps);
  await revision.rollbackAndRetry(deps.messages.value[0]);

  assert.equal(activeRun.active, false);
  assert.deepEqual(sessionRunStore.pendingCommands, []);
  assert.equal(sessionRunStore.isLoading, false);
  assert.equal(deps.messages.value.at(-1).finished, true);
});

test('confirmEditAndResend 在运行中会被拦截，不发起请求', async () => {
  let posted = false;
  await withMock((mock) => {
    mock.onPost(/\/rollback-and-retry$/).reply(() => { posted = true; return [200, { data: { started: true } }]; });
  }, async () => {
    const { deps, toasts, sessionRunStore } = createDeps();
    sessionRunStore.applySessionRuntime({
      state: 'running',
      load_strategy: 'attach_run',
      allowed_actions: ['send_followup', 'stop_run'],
      active_run: {
        run_id: 'run-1',
        status: 'running',
        execution_owner: 'attached',
        task: 'running',
        request_id: 'req-1',
        execution_kind: 'agent_stream',
        started_at: '2026-07-30T00:00:00.000Z',
        updated_at: '2026-07-30T00:00:01.000Z',
        activity: { models: [], tools: [], updated_at: '2026-07-30T00:00:01.000Z' },
      },
      last_run: null,
      pending_interactions: [],
      resume_interaction_id: null,
      maintenance: null,
      observed_at: '2026-07-30T00:00:01.000Z',
    });
    deps.messages.value = [
      { role: 'user', id: 'msg-1', content: 'first' },
      { role: 'assistant', id: 'msg-2', content: 'reply', finished: true },
    ];

    const revision = useMessageRevision(deps);
    revision.startEditMessage(deps.messages.value[0], 0);
    revision.editingDraft.value = 'edited';
    await revision.confirmEditAndResend();

    assert.equal(posted, false);
    assert.deepEqual(toasts, ['请先停止当前任务']);
  });
});

test('resetEditingState 在消息编辑场景会关闭附件抽屉并重置目标', () => {
  const { deps } = createDeps();
  deps.messages.value = [{ role: 'user', id: 'message-1', content: 'draft' }];
  deps.sessionFilesDrawerVisible.value = true;

  const revision = useMessageRevision(deps);
  revision.startEditMessage(deps.messages.value[0], 0);
  deps.sessionFilesDrawerTarget.value = 'message-edit';
  revision.resetEditingState();

  assert.equal(revision.editingMessage.value, null);
  assert.equal(revision.editingDraft.value, '');
  assert.deepEqual(revision.editingAttachmentsDraft.value, []);
  assert.equal(deps.sessionFilesDrawerVisible.value, false);
  assert.equal(deps.sessionFilesDrawerTarget.value, 'composer');
});

test('editing follows message identity instead of array index and survives workbench tab switches', () => {
  const { deps, sessionRunStore } = createDeps();
  deps.messages.value = [
    { role: 'user', id: 'message-1', content: 'first' },
    { role: 'user', id: 'message-2', content: 'second' },
  ];
  const revision = useMessageRevision(deps);
  revision.startEditMessage(deps.messages.value[1]);
  deps.messages.value.unshift({ role: 'system', id: 'summary-1', content: 'summary' });

  assert.equal(revision.editingMessage.value.id, 'message-2');
  // 切到子智能体页签换的是右侧运行工作台在看谁，主对话列没变，编辑框不该被清掉。
  sessionRunStore.setParticipantMessages('child-1', [
    { role: 'user', id: 'child-message-1', content: 'delegated task' },
  ]);
  sessionRunStore.openWorkbenchParticipant('child-1');

  assert.equal(revision.editingMessage.value.id, 'message-2');
  assert.equal(revision.editingDraft.value, 'second');
});

test('child and agent messages cannot enter edit or rollback flows', async () => {
  let rollbackCalls = 0;
  const { deps, sessionRunStore, toasts } = createDeps({
    chatSdkClient: {
      async rollbackAndRetrySession() {
        rollbackCalls += 1;
        return { data: { started: true } };
      },
    },
  });
  const childTask = { role: 'user', id: 'child-message-1', seq: 4, content: 'delegated task', metadata: {} };
  sessionRunStore.setParticipantMessages('child-1', [childTask]);
  sessionRunStore.openWorkbenchParticipant('child-1');
  const revision = useMessageRevision(deps);

  assert.equal(revision.canReviseMessage(childTask), false);
  revision.startEditMessage(childTask);
  assert.equal(revision.editingMessage.value, null);
  await revision.rollbackAndRetry(childTask);

  sessionRunStore.openWorkbenchParticipant('root');
  const agentMessage = {
    role: 'user',
    id: 'agent-message-1',
    seq: 5,
    content: 'internal request',
    metadata: { agent_message: true },
  };
  deps.messages.value = [agentMessage];
  assert.equal(revision.canReviseMessage(agentMessage), false);
  await revision.rollbackAndRetry(agentMessage);

  assert.equal(rollbackCalls, 0);
  assert.deepEqual(toasts, [
    '仅支持从根会话中的用户消息重试',
    '仅支持从根会话中的用户消息重试',
  ]);
});

test('编辑资格随根消息的删除、身份回填和替换更新，正文变化不改变资格', () => {
  const { deps } = createDeps();
  deps.messages.value = [{ role: 'user', id: 'one', content: '开始', metadata: {} }, { role: 'user', content: '待落库', metadata: {} }];
  const revision = useMessageRevision(deps);
  const first = deps.messages.value[0];
  const pending = deps.messages.value[1];
  assert.equal(revision.canReviseMessage(first), true);
  assert.equal(revision.canReviseMessage(pending), false);
  first.content += '追加';
  pending.id = 'two';
  assert.equal(revision.canReviseMessage(first), true);
  assert.equal(revision.canReviseMessage(pending), true);
  deps.messages.value = [{ ...pending }];
  assert.equal(revision.canReviseMessage(first), false);
  assert.equal(revision.canReviseMessage(pending), true);
  deps.messages.value[0].id = 'other';
  assert.equal(revision.canReviseMessage(pending), false);
});
