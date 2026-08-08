import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, ref } from 'vue';
import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

import { useSessionAgentClient } from './useSessionAgentClient.js';
import { useMessageExecution } from './useMessageExecution.js';
import { useWorkPanelSelection } from './useWorkPanelSelection.js';
import { useSessionRunStore } from '../stores/session-run.js';
import { httpClient } from '../api/http.js';

function createAssistantMessage(overrides = {}) {
  return {
    role: 'assistant',
    content: '',
    status: [],
    executionTree: { root: null, steps: [] },
    _execState: null,
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
      : state === 'running'
        ? ['send_followup', 'stop_run']
        : state === 'waiting_interaction' || state === 'suspended'
          ? ['respond_interaction', 'stop_run']
          : state === 'resuming' ? ['stop_run'] : [],
    active_run: active ? {
      run_id: 'run-1',
      status: state,
      execution_owner: state === 'suspended' ? 'detached' : 'attached',
      task: 'task',
      request_id: 'req-1',
      execution_kind: 'agent_stream',
      started_at: '2026-07-30T00:00:00.000Z',
      updated_at: '2026-07-30T00:00:01.000Z',
      activity: { models: [], tools: [], updated_at: '2026-07-30T00:00:01.000Z' },
    } : null,
    last_run: null,
    pending_interactions: state === 'waiting_interaction' || state === 'suspended'
      ? [pendingInteraction('approval', 'approval-default', state === 'suspended' ? 'suspended' : 'waiting')]
      : [],
    resume_interaction_id: null,
    maintenance: state === 'maintenance'
      ? { kind: 'rollback', expires_at: '2026-07-30T00:01:00.000Z' }
      : null,
    observed_at: '2026-07-30T00:00:01.000Z',
    ...overrides,
  };
}

function pendingInteraction(kind, interactionId, status = 'waiting') {
  return {
    interaction_id: interactionId,
    run_id: 'run-1',
    root_run_id: 'run-1',
    batch_id: 'batch-1',
    kind,
    status,
    requested_at: '2026-07-30T00:00:01.000Z',
    payload: kind === 'approval'
      ? { kind, phase: 'required', tool: 'write_file', message: '允许写入？' }
      : { kind, phase: 'required', prompt: 'scope?' },
  };
}

function createDeps(overrides = {}) {
  setActivePinia(createPinia());
  const sessionRunStore = useSessionRunStore();
  const {
    currentSessionId,
    messages,
    isLoading,
    isCompressing,
    contextUsage,
    sessionRuntime,
    optimisticCommand,
    llmRetryState,
    pendingFollowupCandidates,
  } = storeToRefs(sessionRunStore);
  currentSessionId.value = 'session-1';
  contextUsage.value = null;
  sessionRunStore.applySessionRuntime(runtimeSnapshot('idle'));

  const calls = {
    clearCommandFallback: 0,
    deleteMessageCache: [],
    loadSessionMessages: [],
    mergeMessageIdsFromServer: [],
    cacheMessages: [],
    updateRecentSession: [],
    scrollToBottom: [],
    showToast: [],
    clearLlmRetryState: 0,
    handleApprovalResolved: [],
    handleUserInputResolved: [],
    resetApprovalState: [],
    sdkSend: [],
    sdkRespondInteraction: [],
    sdkResume: 0,
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
      calls.sdkSend.push(input);
      return { started: true, runId: 'run-1' };
    },
    stop() {},
    async respondInteraction(...args) { calls.sdkRespondInteraction.push(args); },
    async resume() { calls.sdkResume += 1; return true; },
    getMessageRunSteps(sessionId, messageId) {
      return httpClient.get(
        `/api/agent/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/run-steps`,
      );
    },
  };

  const deps = {
    currentSessionId,
    messages,
    isLoading,
    isCompressing,
    contextUsage,
    sessionRuntime,
    optimisticCommand,
    activeRun: sessionRunStore.activeRun,
    llmRetryState,
    pendingFollowupCandidates,
    userInputDialogRef: ref(null),
    getWS: () => null,
    createAssistantMessage,
    clearSessionResumeRecovery: () => {},
    clearCommandFallback: () => { calls.clearCommandFallback += 1; },
    scheduleCommandFallback: () => {},
    deleteMessageCache: (...args) => { calls.deleteMessageCache.push(args); },
    loadSessionMessages: (...args) => { calls.loadSessionMessages.push(args); },
    mergeMessageIdsFromServer: (...args) => { calls.mergeMessageIdsFromServer.push(args); },
    cacheMessages: (...args) => { calls.cacheMessages.push(args); },
    clearLlmRetryState: () => { calls.clearLlmRetryState += 1; },
    scrollToBottom: (...args) => { calls.scrollToBottom.push(args); },
    showToast: (...args) => { calls.showToast.push(args); },
    setLlmRetryState: () => {},
    updateRecentSession: (...args) => { calls.updateRecentSession.push(args); },
    findRunningExecutionAgentByAgentId: () => null,
    enqueueApproval: () => {},
    handleApprovalResolved: (...args) => { calls.handleApprovalResolved.push(args); },
    handleUserInputResolved: (...args) => { calls.handleUserInputResolved.push(args); },
    resetApprovalState: (...args) => { calls.resetApprovalState.push(args); },
    isRootEvent: () => true,
    isMasterEvent: () => true,
    applyEnvelopeToMessage: () => {},
    handleStop: async () => {},
    chatSdkClient,
    ...overrides,
  };

  return { deps, calls, sessionRunStore };
}

function withMock(setup, run) {
  const mock = new MockAdapter(httpClient);
  setup(mock);
  return Promise.resolve()
    .then(run)
    .finally(() => { mock.restore(); });
}

test('ack(send) 启动失败时会结束当前 assistant 占位并标记失败', () => {
  const { deps, sessionRunStore } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  sessionRunStore.beginOptimisticCommand('send');
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({ type: 'ack', payload: { category: 'send', ok: false, error: 'boom' } }, 'session-1');

  assert.match(deps.messages.value[0].content, /boom/);
  assert.equal(deps.messages.value[0].finished, true);
  assert.equal(deps.sessionRuntime.value.state, 'idle');
  assert.equal(deps.optimisticCommand.value, null);
  assert.equal(deps.activeRun.active, false);
  assert.equal(deps.isLoading.value, false);
});

test('state_sync(command_result) 会补建 assistant 消息并触发静默刷新', async () => {
  const { deps, calls, sessionRunStore } = createDeps();
  deps.messages.value = [{ role: 'user', content: '/foo' }];
  sessionRunStore.beginOptimisticCommand('send');

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'state_sync',
    payload: {
      category: 'command_result',
      detail: { content: '命令完成', command: 'foo', invocation_id: 'cmd-1', success: true },
    },
  }, 'session-1');
  await nextTick();

  assert.equal(deps.messages.value.length, 2);
  assert.equal(deps.messages.value[1].role, 'assistant');
  assert.equal(deps.messages.value[1].content, '命令完成');
  assert.deepEqual(deps.messages.value[1].content_parts, [{
    type: 'command_result',
    invocation_id: 'cmd-1',
    name: 'foo',
    success: true,
    text: '命令完成',
  }]);
  assert.equal(deps.messages.value[1].finished, true);
  assert.equal(deps.isLoading.value, false);
  assert.deepEqual(calls.deleteMessageCache, [['session-1']]);
  assert.deepEqual(calls.loadSessionMessages, [['session-1', { silent: true }]]);
  assert.deepEqual(calls.scrollToBottom, [[true]]);
});

test('state_sync(session_updated) 在非执行态会触发消息刷新', () => {
  const { deps, calls } = createDeps();

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({ type: 'state_sync', payload: { category: 'session_updated' } }, 'session-1');

  assert.deepEqual(calls.deleteMessageCache, [['session-1']]);
  assert.deepEqual(calls.loadSessionMessages, [['session-1', { silent: true }]]);
});

test('state_sync(session_updated) 在 active run 期间不重拉消息', () => {
  const { deps, calls, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({ type: 'state_sync', payload: { category: 'session_updated' } }, 'session-1');

  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);
});

test('后台任务 lifecycle 事件只更新运行中心，不重拉消息列表', () => {
  const lifecycle = [];
  const { deps, calls } = createDeps({
    handleBackgroundTaskLifecycle: detail => lifecycle.push(detail),
  });
  const detail = {
    entity: 'background_task',
    action: 'completed',
    task: { task_id: 'task-1', status: 'completed' },
  };

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'state_sync',
    payload: { category: 'session_updated', detail },
  }, 'session-1');

  assert.deepEqual(lifecycle, [detail]);
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);
});

test('已送达但由顶层处理的事件会推进 seq，避免后续输出误判 gap', () => {
  const { deps, calls, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.lastSeenSeq = 1;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({ type: 'ack', payload: { category: 'send', ok: true }, run_id: 'run-1', seq: 2 }, 'session-1');
  stream.handleEnvelope({ type: 'stream_output', payload: { phase: 'delta', content: 'hello' }, seq: 3 }, 'session-1');
  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'completed' }, seq: 4 }, 'session-1');

  assert.equal(deps.messages.value[0].content, 'hello');
  assert.deepEqual(calls.mergeMessageIdsFromServer, []);
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);
});

test('刚完成的同一 run 收到 state_sync(session_updated) 不重拉整条消息列表', () => {
  const { deps, calls, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  deps.messages.value = [createAssistantMessage({ content: 'final answer' })];
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.runId = 'run-1';

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'completed' } }, 'session-1');
  stream.handleEnvelope({ type: 'state_sync', payload: { category: 'session_updated', run_id: 'run-1' } }, 'session-1');

  assert.deepEqual(calls.mergeMessageIdsFromServer, [['session-1']]);
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);
});

test('stream_output(final) 会用完整内容补偿并保留已有 metadata', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage({
    content: 'final',
    metadata: { run_id: 'run-1', existing: true },
  })];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'stream_output',
    payload: { phase: 'final', content: 'final answer' },
  }, 'session-1');

  assert.equal(deps.messages.value[0].content, 'final answer');
  assert.equal(deps.messages.value[0].metadata.run_id, 'run-1');
  assert.equal(deps.messages.value[0].metadata.existing, true);
  assert.equal(deps.messages.value[0].finished, true);
});

test('子 Run 的终态 stream_output 即使缺少 lineage 也不会覆盖根回答', () => {
  const { deps } = createDeps();
  const execution = useMessageExecution({
    currentSessionId: deps.currentSessionId,
    chatSdkClient: deps.chatSdkClient,
    activeRun: deps.activeRun,
  });
  deps.createAssistantMessage = execution.createAssistantMessage;
  deps.applyEnvelopeToMessage = execution.applyEnvelopeToMessage;
  deps.isRootEvent = execution.isRootEvent;
  deps.isMasterEvent = execution.isMasterEvent;
  deps.messages.value = [createAssistantMessage({
    content: '根回答',
    run_id: 'run-root',
    metadata: { run_id: 'run-root' },
  })];
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.runId = 'run-root';

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'stream_output',
    run_id: 'run-child',
    call_id: 'child-call',
    agent_id: 'child-agent',
    payload: { phase: 'final', content: '子 Agent 最终结果' },
  }, 'session-1');

  assert.equal(deps.messages.value[0].content, '根回答');
  assert.equal(deps.messages.value[0].finished, false);
});

test('state_sync(message_saved) 会将确认的 run 内 followup 移入执行树注入列表', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [
    { role: 'user', content: '原始任务', metadata: {}, attachments: [] },
    createAssistantMessage({ content: 'partial answer' }),
  ];
  deps.pendingFollowupCandidates.value = [{
    role: 'user',
    content: '运行中补充',
    metadata: {
      request_id: 'req-followup',
      execution_kind: 'session_followup',
      source: 'running_session',
      persistence_status: 'pending',
      run_id: 'run-1',
    },
    attachments: [],
  }];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 1;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'state_sync',
    run_id: 'run-1',
    payload: {
      category: 'message_saved',
      ref: {
        message_id: 'msg-followup',
        seq: 12,
        role: 'user',
        request_id: 'req-followup',
        run_id: 'run-1',
        task_id: 'task-1',
        round_index: 4,
      },
    },
  }, 'session-1');

  assert.equal(deps.messages.value[0].id, undefined);
  assert.equal(deps.messages.value[2].id, 'msg-followup');
  assert.equal(deps.messages.value[2].seq, 12);
  assert.equal(deps.messages.value[2].metadata.persistence_status, undefined);
  assert.equal(deps.messages.value[2].metadata.run_id, 'run-1');
  assert.equal(deps.messages.value[2].metadata.task_id, 'task-1');
  assert.equal(deps.messages.value[2].metadata.round_index, 4);
  assert.equal(deps.pendingFollowupCandidates.value.length, 0);
  assert.deepEqual(calls.cacheMessages, [['session-1', deps.messages.value]]);
});

test('state_sync(message_saved) 用服务端 canonical content_parts 校准乐观用户消息', () => {
  const { deps } = createDeps();
  deps.messages.value = [{
    role: 'user',
    content: '/review src',
    content_parts: [{ type: 'text', text: '/review src' }],
    metadata: { persistence_status: 'pending' },
    attachments: [],
  }, createAssistantMessage()];
  deps.activeRun.assistantMsgIndex = 1;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'state_sync',
    payload: {
      category: 'message_saved',
      ref: {
        message_id: 'msg-command',
        seq: 3,
        role: 'user',
        content_parts: [{
          type: 'command_ref',
          invocation_id: 'cmd-1',
          name: 'review',
          args: 'src',
          raw_text: '/review src',
          resolution: {
            kind: 'prompt',
            agent_text: '请审查 src',
            snapshot_id: 'sha256:test',
          },
        }, {
          type: 'attachment_ref',
          file_id: 'file-1',
          original_name: 'input.txt',
          stored_name: 'input.txt',
          mime: 'text/plain',
          size: 4,
          kind: 'file',
          presentation: 'attachment',
        }],
      },
    },
  }, 'session-1');

  assert.equal(deps.messages.value[0].id, 'msg-command');
  assert.equal(deps.messages.value[0].content_parts[0].type, 'command_ref');
  assert.deepEqual(deps.messages.value[0].attachments, [{
    file_id: 'file-1',
    original_name: 'input.txt',
    stored_name: 'input.txt',
    mime: 'text/plain',
    size: 4,
    kind: 'file',
    source: 'session',
  }]);
});

test('旧 Run 的 assistant message_saved 不会覆盖当前 Run 消息', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage({
    run_id: 'run-new',
    metadata: { run_id: 'run-new' },
    content: '当前运行',
  })];
  deps.activeRun.active = true;
  deps.activeRun.runId = 'run-new';
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'state_sync',
    run_id: 'run-old',
    payload: {
      category: 'message_saved',
      ref: {
        message_id: 'run-old:terminal',
        seq: 8,
        role: 'assistant',
        content_parts: [{ type: 'text', text: '旧运行失败' }],
      },
    },
  }, 'session-1');

  assert.equal(deps.messages.value.length, 1);
  assert.equal(deps.messages.value[0].content, '当前运行');
  assert.deepEqual(calls.cacheMessages, []);
});

test('run_started 后的 message_saved 只确认一次已结束 followup 的新 run 主消息', () => {
  const { deps } = createDeps();
  deps.messages.value = [
    { role: 'user', content: '原始任务', metadata: {}, attachments: [] },
    createAssistantMessage({ content: '旧 run 输出', metadata: { run_id: 'run-old' } }),
  ];
  deps.pendingFollowupCandidates.value = [{
    role: 'user',
    content: '旧 run 结束后发送的补充',
    metadata: {
      request_id: 'req-new-run',
      execution_kind: 'session_followup',
      source: 'running_session',
      persistence_status: 'pending',
      run_id: 'run-old',
    },
    attachments: [],
  }];
  Object.assign(deps.activeRun, { active: true, assistantMsgIndex: 1, runId: 'run-old' });

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'run_started',
    run_id: 'run-new',
    payload: { request_id: 'req-new-run', task: '旧 run 结束后发送的补充' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'state_sync',
    run_id: 'run-new',
    payload: {
      category: 'message_saved',
      ref: {
        message_id: 'msg-new',
        seq: 20,
        role: 'user',
        request_id: 'req-new-run',
      },
    },
  }, 'session-1');

  assert.deepEqual(deps.messages.value.map(message => [message.role, message.content]), [
    ['user', '原始任务'],
    ['assistant', '旧 run 输出'],
    ['user', '旧 run 结束后发送的补充'],
    ['assistant', ''],
  ]);
  assert.equal(deps.messages.value[1].finished, true);
  assert.equal(deps.messages.value[2].metadata.execution_kind, 'agent_stream');
  assert.equal(deps.messages.value[2].metadata.source, undefined);
  assert.equal(deps.messages.value[2].metadata.run_id, 'run-new');
  assert.equal(deps.messages.value[2].id, 'msg-new');
  assert.equal(deps.messages.value[2].seq, 20);
  assert.equal(deps.messages.value.filter(message => message.role === 'user' && message.metadata?.run_id === 'run-new').length, 1);
  assert.equal(deps.messages.value.filter(message => message.role === 'assistant' && message.run_id === 'run-new').length, 1);
  assert.equal(deps.messages.value[3].run_id, 'run-new');
  assert.equal(deps.activeRun.assistantMsgIndex, 3);
  assert.equal(deps.pendingFollowupCandidates.value.length, 0);
});

test('goal continuation 的 run_started 会立即插入可见通知，无需刷新消息列表', () => {
  const { deps } = createDeps();
  deps.messages.value = [
    { role: 'user', content: '初始任务', metadata: {}, attachments: [] },
    createAssistantMessage({ content: '上一轮完成', finished: true, run_id: 'run-old' }),
  ];
  Object.assign(deps.activeRun, { active: false, assistantMsgIndex: 1, runId: 'run-old' });

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'run_started',
    run_id: 'run-goal-2',
    payload: {
      source: 'system.goal_continuation',
      request_id: 'req-goal-2',
      task: '<goal-continuation>继续推进</goal-continuation>',
    },
  }, 'session-1');

  assert.deepEqual(deps.messages.value.map(message => message.role), [
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
  assert.equal(deps.messages.value[2].metadata.source, 'goal_continuation');
  assert.equal(deps.messages.value[2].metadata.request_id, 'req-goal-2');
  assert.equal(deps.messages.value[2].metadata.run_id, 'run-goal-2');
  assert.equal(deps.activeRun.assistantMsgIndex, 3);
});

test('连续 Goal 自动续跑后，工作栏仍用 assistant message id 加载 execution steps', async () => {
  const requestedUrls = [];
  await withMock((mock) => {
    mock.onGet().reply((config) => {
      requestedUrls.push(config.url);
      return [200, { data: { items: [] } }];
    });
  }, async () => {
    const { deps } = createDeps();
    const previousAssistant = createAssistantMessage({
      id: 'assistant-goal-1',
      content: '第一轮 Goal 结果',
      finished: true,
      has_execution: true,
      executionStepsLoaded: true,
      run_id: 'run-goal-1',
      metadata: { run_id: 'run-goal-1' },
    });
    deps.messages.value = [
      {
        id: 'goal-user-1',
        role: 'user',
        content: '<goal-continuation>第一轮</goal-continuation>',
        metadata: { source: 'goal_continuation', request_id: 'req-goal-1', run_id: 'run-goal-1' },
        attachments: [],
      },
      previousAssistant,
    ];
    Object.assign(deps.activeRun, { active: false, assistantMsgIndex: 1, runId: 'run-goal-1' });

    const stream = useSessionAgentClient(deps);
    stream.handleEnvelope({
      type: 'run_started',
      run_id: 'run-goal-2',
      payload: {
        source: 'system.goal_continuation',
        request_id: 'req-goal-2',
        task: '<goal-continuation>第二轮</goal-continuation>',
      },
    }, 'session-1');
    stream.handleEnvelope({
      type: 'state_sync',
      run_id: 'run-goal-2',
      payload: {
        category: 'message_saved',
        ref: {
          message_id: 'goal-user-2',
          seq: 3,
          role: 'user',
          request_id: 'req-goal-2',
          run_id: 'run-goal-2',
        },
      },
    }, 'session-1');

    const nextGoalUser = deps.messages.value.find(
      message => message.role === 'user' && message.metadata?.request_id === 'req-goal-2',
    );
    assert.equal(nextGoalUser?.id, 'goal-user-2');
    assert.equal(previousAssistant.id, 'assistant-goal-1');

    const execution = useMessageExecution({
      currentSessionId: deps.currentSessionId,
      chatSdkClient: deps.chatSdkClient,
      showToast: () => {},
    });
    const selection = useWorkPanelSelection({
      messages: deps.messages,
      activeRun: deps.activeRun,
      hasExecutionContent: execution.hasExecutionContent,
      ensureExecutionStepsLoaded: execution.ensureExecutionStepsLoaded,
      showToast: () => {},
    });
    await nextTick();
    previousAssistant.executionStepsLoaded = false;

    await selection.selectWorkPanelMessage(previousAssistant);

    assert.deepEqual(requestedUrls.filter(url => url?.includes('/run-steps')), [
      '/api/agent/sessions/session-1/messages/assistant-goal-1/run-steps',
    ]);
  });
});

test('run_ended 只收尾展示，直到 runtime 快照确认终态', () => {
  const { deps, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  deps.messages.value = [createAssistantMessage({ content: 'final answer' })];
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'run_ended',
    payload: { status: 'completed' },
  }, 'session-1');

  assert.equal(deps.messages.value[0].finished, true);
  assert.equal(deps.sessionRuntime.value.state, 'running');
  assert.equal(deps.isLoading.value, true);

  stream.handleEnvelope({
    type: 'session.runtime',
    payload: runtimeSnapshot('idle', {
      last_run: {
        run_id: 'run-1',
        status: 'completed',
        task: 'task',
        started_at: '2026-07-30T00:00:00.000Z',
        finished_at: '2026-07-30T00:00:02.000Z',
      },
    }),
  }, 'session-1');
  assert.equal(deps.activeRun.active, false);
  assert.equal(deps.sessionRuntime.value.last_run.status, 'completed');
  assert.equal(deps.isLoading.value, false);
});

test('子 Run 的 run_ended 不会提前结束仍在运行的根 Run', () => {
  const { deps, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  deps.messages.value = [createAssistantMessage({
    content: '父 Run 尚未完成',
    run_id: 'run-root',
    metadata: { run_id: 'run-root' },
  })];
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.runId = 'run-root';

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'run_ended',
    run_id: 'run-child',
    payload: { status: 'completed' },
  }, 'session-1');

  assert.equal(deps.activeRun.active, true);
  assert.equal(deps.messages.value[0].finished, false);

  stream.handleEnvelope({
    type: 'run_ended',
    run_id: 'run-root',
    payload: { status: 'completed' },
  }, 'session-1');

  assert.equal(deps.activeRun.active, false);
  assert.equal(deps.messages.value[0].finished, true);
});

test('根 Run 中断后迟到的子 Agent 终态仍会更新执行树状态', () => {
  const { deps, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  const execution = useMessageExecution({
    currentSessionId: deps.currentSessionId,
    chatSdkClient: deps.chatSdkClient,
    activeRun: deps.activeRun,
  });
  deps.applyEnvelopeToMessage = execution.applyEnvelopeToMessage;
  deps.isRootEvent = execution.isRootEvent;
  deps.isMasterEvent = execution.isMasterEvent;
  deps.messages.value = [execution.createAssistantMessage({
    run_id: 'run-root',
    metadata: { run_id: 'run-root' },
  })];
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.runId = 'run-root';

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'agent_started', run_id: 'run-root', call_id: 'root-call', agent_id: 'root-agent',
    payload: { phase: 'start', task: 'root task' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'agent_started', run_id: 'run-root', call_id: 'child-call', agent_id: 'worker',
    payload: { phase: 'start', task: 'child task', lineage: { parent_call_id: 'root-call' } },
  }, 'session-1');

  const child = deps.messages.value[0].executionTree.root.children[0];
  assert.equal(child.status, 'running');

  stream.handleEnvelope({
    type: 'run_ended', run_id: 'run-root', payload: { status: 'interrupted', reason: 'session_stopped' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'agent_ended', run_id: 'run-child', call_id: 'child-call', agent_id: 'worker',
    payload: { phase: 'end', success: false, status: 'interrupted', result: '本次运行已中断', lineage: { parent_call_id: 'root-call' } },
  }, 'session-1');

  assert.equal(deps.activeRun.active, false);
  assert.equal(child.status, 'interrupted');
  assert.equal(child.result, '本次运行已中断');
});

test('Run A 结束并启动 Run B 后，Run A child 的迟到终态只更新 Run A', () => {
  const { deps, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  const execution = useMessageExecution({
    currentSessionId: deps.currentSessionId,
    chatSdkClient: deps.chatSdkClient,
    activeRun: deps.activeRun,
  });
  deps.applyEnvelopeToMessage = execution.applyEnvelopeToMessage;
  deps.isRootEvent = execution.isRootEvent;
  deps.isMasterEvent = execution.isMasterEvent;
  deps.messages.value = [execution.createAssistantMessage({
    run_id: 'run-a',
    metadata: { run_id: 'run-a', execution_run_ids: ['run-a'] },
  })];
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.runId = 'run-a';

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'agent_started', run_id: 'run-a', call_id: 'root-call-a', agent_id: 'root-agent',
    payload: { phase: 'start', task: 'root task A' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'agent_started', run_id: 'run-a-child', call_id: 'child-call-a', agent_id: 'worker',
    payload: { phase: 'start', task: 'child task A', lineage: { parent_call_id: 'root-call-a' } },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'run_ended', run_id: 'run-a', payload: { status: 'interrupted', reason: 'session_stopped' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'run_started', run_id: 'run-b', payload: { task: 'root task B' },
  }, 'session-1');
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running', {
    active_run: { ...runtimeSnapshot('running').active_run, run_id: 'run-b' },
  }));
  stream.handleEnvelope({
    type: 'agent_started', run_id: 'run-b', call_id: 'root-call-b', agent_id: 'root-agent',
    payload: { phase: 'start', task: 'root task B' },
  }, 'session-1');

  const runAMessage = deps.messages.value[0];
  const runBMessage = deps.messages.value[1];
  const runAChild = runAMessage.executionTree.root.children[0];
  stream.handleEnvelope({
    type: 'agent_ended', run_id: 'run-a-child', call_id: 'child-call-a', agent_id: 'worker',
    payload: {
      phase: 'end', success: false, status: 'interrupted', result: 'A child stopped',
      lineage: { parent_call_id: 'root-call-a' },
    },
  }, 'session-1');

  assert.equal(runAChild.status, 'interrupted');
  assert.equal(runAChild.result, 'A child stopped');
  assert.equal(runBMessage.executionTree.root.callId, 'root-call-b');
  assert.equal(runBMessage.executionTree.root.children.length, 0);
  assert.equal(deps.activeRun.active, true);
  assert.equal(deps.activeRun.runId, 'run-b');
});

test('durable outbox 纯终态 replay 不创建空 assistant 占位', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [
    createAssistantMessage({
      content: '已加载的回答',
      finished: true,
      run_id: 'run-1',
      metadata: { run_id: 'run-1' },
    }),
  ];

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'session.reconnect',
    run_id: 'run-1',
    payload: { phase: 'start', replay_source: 'durable_outbox' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'run_ended',
    run_id: 'run-1',
    payload: { status: 'completed', replay_source: 'durable_outbox' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'session.reconnect',
    payload: { phase: 'end', replay_source: 'durable_outbox' },
  }, 'session-1');

  assert.equal(deps.messages.value.length, 1);
  assert.equal(deps.messages.value[0].content, '已加载的回答');
  assert.equal(deps.activeRun.active, false);
  assert.equal(deps.activeRun.isReplaying, false);
  assert.equal(deps.isLoading.value, false);
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);
});

test('durable outbox replay 只有真实 run 事件才懒恢复 activeRun 并收尾', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [{ role: 'user', content: 'hello', metadata: { request_id: 'req-1' } }];

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'session.reconnect',
    run_id: 'run-1',
    payload: { phase: 'start', replay_source: 'durable_outbox' },
  }, 'session-1');

  assert.equal(deps.messages.value.length, 1);
  assert.equal(deps.activeRun.active, false);

  stream.handleEnvelope({
    type: 'run_started',
    run_id: 'run-1',
    payload: { replay_source: 'durable_outbox' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'stream_output',
    run_id: 'run-1',
    payload: { phase: 'delta', content: 'hello ', replay_source: 'durable_outbox' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'stream_output',
    run_id: 'run-1',
    payload: { phase: 'final', content: 'hello world', replay_source: 'durable_outbox' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'state_sync',
    run_id: 'run-1',
    payload: {
      category: 'message_saved',
      replay_source: 'durable_outbox',
      ref: { id: 'msg-1', seq: 2, role: 'assistant', run_id: 'run-1' },
    },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'run_ended',
    run_id: 'run-1',
    payload: { status: 'completed', replay_source: 'durable_outbox' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'session.reconnect',
    payload: { phase: 'end', replay_source: 'durable_outbox' },
  }, 'session-1');

  const assistant = deps.messages.value.find(msg => msg.role === 'assistant');
  assert.equal(assistant.content, 'hello world');
  assert.equal(assistant.finished, true);
  assert.equal(assistant.id, 'msg-1');
  assert.equal(assistant.seq, 2);
  assert.equal(deps.activeRun.active, false);
  assert.equal(deps.activeRun.isReplaying, false);
  assert.deepEqual(calls.loadSessionMessages, []);
});

test('durable outbox child-first replay 复用 root assistant，不创建 child 占位', () => {
  const { deps } = createDeps();
  deps.messages.value = [{ role: 'user', content: 'hello', metadata: { request_id: 'req-1' } }];
  const stream = useSessionAgentClient(deps);

  stream.handleEnvelope({
    type: 'session.reconnect',
    run_id: 'run-root',
    payload: { phase: 'start', replay_source: 'durable_outbox' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'agent_started',
    run_id: 'run-child',
    call_id: 'child-call',
    agent_id: 'worker',
    payload: { phase: 'start', lineage: { parent_call_id: 'root-call' }, replay_source: 'durable_outbox' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'stream_output',
    run_id: 'run-child',
    call_id: 'child-call',
    agent_id: 'worker',
    payload: {
      phase: 'final', content: 'child output',
      lineage: { parent_call_id: 'root-call' }, replay_source: 'durable_outbox',
    },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'state_sync',
    run_id: 'run-child',
    payload: {
      category: 'message_saved',
      lineage: { parent_call_id: 'root-call' },
      ref: { id: 'child-terminal', seq: 3, role: 'assistant', content_parts: [{ type: 'text', text: 'child output' }] },
      replay_source: 'durable_outbox',
    },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'agent_ended',
    run_id: 'run-child',
    call_id: 'child-call',
    agent_id: 'worker',
    payload: {
      phase: 'end', success: true, status: 'succeeded',
      lineage: { parent_call_id: 'root-call' }, replay_source: 'durable_outbox',
    },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'run_ended',
    run_id: 'run-child',
    payload: { status: 'completed', lineage: { parent_call_id: 'root-call' }, replay_source: 'durable_outbox' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'run_ended',
    run_id: 'run-root',
    payload: { status: 'completed', replay_source: 'durable_outbox' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'session.reconnect',
    payload: { phase: 'end', replay_source: 'durable_outbox' },
  }, 'session-1');

  const assistants = deps.messages.value.filter(message => message.role === 'assistant');
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].run_id, 'run-root');
  assert.equal(assistants[0].finished, true);
  assert.equal(deps.activeRun.active, false);
});


test('run_started 只确认 Agent 已进入处理态，不猜测模型请求已经发出', () => {
  const { deps, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'run_started',
    timestamp: 100,
    run_id: 'run-1',
  }, 'session-1');

  assert.equal(deps.activeRun.runId, 'run-1');
  assert.equal(deps.activeRun.phase, 'processing');
  assert.equal(deps.activeRun.runStartedAt, Date.parse('2026-07-30T00:00:00.000Z') / 1000);
  assert.equal(deps.activeRun.firstTokenAt, null);
  assert.equal(deps.activeRun.firstTokenLatencyMs, null);
  assert.equal(deps.isLoading.value, true);
});

test('idle runtime 在 run_started 前到达时复用乐观 assistant 占位', () => {
  const { deps, sessionRunStore } = createDeps();
  deps.messages.value = [
    { role: 'user', content: '新任务', metadata: {}, attachments: [] },
    createAssistantMessage(),
  ];
  deps.activeRun.assistantMsgIndex = 1;
  // Connection bootstrap may reconcile the optimistic command to idle before
  // the server publishes run_started.
  sessionRunStore.applySessionRuntime(runtimeSnapshot('idle'));

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'run_started',
    run_id: 'run-new',
    payload: { request_id: 'req-new' },
  }, 'session-1');

  assert.equal(deps.messages.value.filter(message => message.role === 'assistant').length, 1);
  assert.equal(deps.messages.value[1].run_id, 'run-new');
  assert.equal(deps.activeRun.assistantMsgIndex, 1);
  assert.equal(deps.activeRun.active, true);
});

test('model_request 到达后才进入等待模型响应', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'model_request',
    run_id: 'run-1',
    call_id: 'root-call',
    agent_id: 'agent',
    payload: { phase: 'start', round: 2 },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'model_waiting');
});

test('模型物理 attempt 按 start → retry wait → next start → completed 收敛', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.setLlmRetryState = state => { deps.llmRetryState.value = state; };
  deps.clearLlmRetryState = () => {
    calls.clearLlmRetryState += 1;
    deps.llmRetryState.value = null;
  };

  const stream = useSessionAgentClient(deps);
  const identity = { run_id: 'run-1', call_id: 'root-call', agent_id: 'agent' };
  stream.handleEnvelope({
    type: 'model_request',
    ...identity,
    payload: { phase: 'start', round: 2 },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'model_attempt_started',
    ...identity,
    payload: {
      phase: 'start', attempt_id: 'attempt-1', attempt: 1, max_attempts: 3,
      round: 2, provider: 'openai', model: 'gpt-test',
    },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'model_attempt_failed',
    ...identity,
    payload: {
      phase: 'failed', attempt_id: 'attempt-1', attempt: 1, max_attempts: 3,
      round: 2, provider: 'openai', model: 'gpt-test', will_retry: true,
      retry_delay_ms: 1200, elapsed_ms: 80, error: '503',
    },
  }, 'session-1');

  const key = 'agent\u0000root-call';
  assert.equal(deps.activeRun.phase, 'retrying');
  assert.equal(deps.activeRun.runningModelCalls[key].attempt_id, 'attempt-1');
  assert.equal(deps.activeRun.runningModelCalls[key].status, 'retry_wait');
  assert.equal(deps.llmRetryState.value.nextAttempt, 2);
  assert.ok(deps.llmRetryState.value.waitMs > 0 && deps.llmRetryState.value.waitMs <= 1200);

  stream.handleEnvelope({
    type: 'model_attempt_started',
    ...identity,
    payload: {
      phase: 'start', attempt_id: 'attempt-2', attempt: 2, max_attempts: 3,
      round: 2, provider: 'openai', model: 'gpt-test',
    },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'model_waiting');
  assert.equal(deps.activeRun.runningModelCalls[key].attempt_id, 'attempt-2');
  assert.equal(deps.activeRun.runningModelCalls[key].status, 'waiting');
  assert.equal(deps.llmRetryState.value, null);

  stream.handleEnvelope({
    type: 'model_attempt_completed',
    ...identity,
    payload: {
      phase: 'end', attempt_id: 'attempt-2', attempt: 2, max_attempts: 3,
      round: 2, provider: 'openai', model: 'gpt-test', elapsed_ms: 240,
    },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'processing');
  assert.deepEqual(deps.activeRun.runningModelCalls, {});
});

test('session.runtime 从 retry_wait 恢复倒计时状态', () => {
  const { deps } = createDeps();
  let restoredRetry = null;
  deps.setLlmRetryState = state => {
    restoredRetry = state;
    deps.llmRetryState.value = state;
  };
  const retryAt = new Date(Date.now() + 5000).toISOString();
  const snapshot = runtimeSnapshot('running');
  snapshot.active_run.activity.models.push({
    call_id: 'root-call',
    agent_id: 'agent',
    round: 0,
    status: 'retry_wait',
    attempt_id: 'attempt-1',
    attempt: 1,
    max_attempts: 3,
    provider: 'openai',
    model: 'gpt-test',
    started_at: new Date().toISOString(),
    retry_at: retryAt,
    error: 'rate limited',
    updated_at: new Date().toISOString(),
  });

  useSessionAgentClient(deps).handleEnvelope({
    type: 'session.runtime',
    payload: snapshot,
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'retrying');
  assert.equal(restoredRetry.nextAttempt, 2);
  assert.equal(restoredRetry.maxAttempts, 3);
  assert.equal(restoredRetry.error, 'rate limited');
  assert.equal(restoredRetry.callId, 'root-call');
  assert.equal(restoredRetry.agentId, 'agent');
  assert.ok(restoredRetry.waitMs > 0 && restoredRetry.waitMs <= 5000);
});

test('并发模型事件不会清除其他调用的重试状态', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.setLlmRetryState = state => { deps.llmRetryState.value = state; };
  deps.clearLlmRetryState = () => {
    calls.clearLlmRetryState += 1;
    deps.llmRetryState.value = null;
  };
  const stream = useSessionAgentClient(deps);
  const retryPayload = attempt => ({
    phase: 'failed', attempt_id: `attempt-${attempt}`, attempt, max_attempts: 3,
    round: 1, provider: 'openai', model: 'gpt-test', will_retry: true,
    retry_delay_ms: 5000, elapsed_ms: 50, error: 'rate limited',
  });

  stream.handleEnvelope({
    type: 'model_attempt_failed', run_id: 'run-a', call_id: 'call-a', agent_id: 'worker',
    payload: retryPayload(1),
  }, 'session-1');
  stream.handleEnvelope({
    type: 'model_request', run_id: 'run-b', call_id: 'call-b', agent_id: 'worker',
    payload: { phase: 'start', round: 1 },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'tool_call', run_id: 'run-b', call_id: 'tool-b', agent_id: 'worker',
    payload: { phase: 'start', tool: 'search', input: {}, lineage: { parent_call_id: 'call-b' } },
  }, 'session-1');

  assert.equal(deps.llmRetryState.value.callId, 'call-a');
  assert.equal(calls.clearLlmRetryState, 0);

  stream.handleEnvelope({
    type: 'model_attempt_failed', run_id: 'run-b', call_id: 'call-b', agent_id: 'worker',
    payload: retryPayload(1),
  }, 'session-1');
  stream.handleEnvelope({
    type: 'model_attempt_started', run_id: 'run-a', call_id: 'call-a', agent_id: 'worker',
    payload: {
      phase: 'start', attempt_id: 'attempt-2', attempt: 2, max_attempts: 3,
      round: 1, provider: 'openai', model: 'gpt-test',
    },
  }, 'session-1');

  assert.equal(deps.llmRetryState.value.callId, 'call-b');
  assert.equal(calls.clearLlmRetryState, 0);
});

test('并发工具按 call_id 收敛，最后一个结果到达前保持工具执行中', () => {
  const { deps } = createDeps();
  const execution = useMessageExecution({
    currentSessionId: deps.currentSessionId,
    chatSdkClient: deps.chatSdkClient,
    activeRun: deps.activeRun,
  });
  deps.applyEnvelopeToMessage = execution.applyEnvelopeToMessage;
  deps.isRootEvent = execution.isRootEvent;
  deps.isMasterEvent = execution.isMasterEvent;
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.runId = 'run-1';

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'agent_started',
    run_id: 'run-1',
    call_id: 'root-call',
    agent_id: 'agent',
    payload: { phase: 'start' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'tool_call',
    run_id: 'run-1',
    call_id: 'tool-1',
    payload: { phase: 'start', tool: 'read_file', input: {}, lineage: { parent_call_id: 'root-call' } },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'tool_call',
    run_id: 'run-1',
    call_id: 'tool-2',
    payload: { phase: 'start', tool: 'search', input: {}, lineage: { parent_call_id: 'root-call' } },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'tool_running');
  assert.deepEqual(Object.keys(deps.activeRun.runningToolCalls).sort(), ['tool-1', 'tool-2']);

  stream.handleEnvelope({
    type: 'tool_result',
    run_id: 'run-1',
    call_id: 'tool-1',
    payload: { phase: 'end', tool: 'read_file', ok: true, lineage: { parent_call_id: 'root-call' } },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'tool_running');
  assert.deepEqual(Object.keys(deps.activeRun.runningToolCalls), ['tool-2']);

  stream.handleEnvelope({
    type: 'tool_result',
    run_id: 'run-1',
    call_id: 'tool-2',
    payload: { phase: 'end', tool: 'search', ok: true, lineage: { parent_call_id: 'root-call' } },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'processing');
  assert.deepEqual(deps.activeRun.runningToolCalls, {});

  deps.activeRun.phase = 'model_waiting';
  stream.handleEnvelope({
    type: 'tool_result',
    run_id: 'run-1',
    call_id: 'tool-2',
    payload: { phase: 'end', tool: 'search', ok: true, lineage: { parent_call_id: 'root-call' } },
  }, 'session-1');
  assert.equal(deps.activeRun.phase, 'model_waiting');

  stream.handleEnvelope({
    type: 'agent_started',
    run_id: 'run-child',
    call_id: 'child-call',
    agent_id: 'child-agent',
    payload: { phase: 'start', task: 'child task', lineage: { parent_call_id: 'root-call' } },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'tool_call',
    run_id: 'run-child',
    call_id: 'child-tool',
    payload: { phase: 'start', tool: 'child_work', input: {}, lineage: { parent_call_id: 'child-call' } },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'tool_running');
  assert.deepEqual(deps.activeRun.runningToolCalls, {
    'child-tool': { tool: 'child_work', agent_id: '', parent_call_id: 'child-call' },
  });
});

test('agent_ended 清理对应子 Agent 的悬挂模型和工具活动', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.isMasterEvent = event => event.agent_id === 'root-agent';
  const stream = useSessionAgentClient(deps);

  stream.handleEnvelope({
    type: 'model_request', run_id: 'child-run-1', call_id: 'child-model', agent_id: 'child-1',
    payload: { phase: 'start', round: 0 },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'tool_call', run_id: 'child-run-2', call_id: 'child-tool', agent_id: 'child-2',
    payload: { phase: 'start', tool: 'search', input: {}, lineage: { parent_call_id: 'child-agent-call' } },
  }, 'session-1');
  assert.equal(deps.activeRun.phase, 'parallel_running');

  stream.handleEnvelope({
    type: 'agent_ended', run_id: 'child-run-1', call_id: 'child-model', agent_id: 'child-1',
    payload: { phase: 'end', success: false, status: 'failed' },
  }, 'session-1');
  assert.deepEqual(deps.activeRun.runningModelCalls, {});
  assert.equal(deps.activeRun.phase, 'tool_running');

  stream.handleEnvelope({
    type: 'agent_ended', run_id: 'child-run-2', call_id: 'child-agent-call', agent_id: 'child-2',
    payload: { phase: 'end', success: true, status: 'succeeded' },
  }, 'session-1');
  assert.deepEqual(deps.activeRun.runningToolCalls, {});
  assert.equal(deps.activeRun.phase, 'processing');
  assert.equal(deps.messages.value[0].finished, false);
});

test('同名 Agent 并发结束时只清理对应 invocation 的活动', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.isMasterEvent = () => false;
  const stream = useSessionAgentClient(deps);

  for (const callId of ['worker-call-1', 'worker-call-2']) {
    stream.handleEnvelope({
      type: 'model_request', run_id: `run-${callId}`, call_id: callId, agent_id: 'worker',
      payload: { phase: 'start', round: 0 },
    }, 'session-1');
    stream.handleEnvelope({
      type: 'tool_call', run_id: `run-${callId}`, call_id: `tool-${callId}`, agent_id: 'worker',
      payload: {
        phase: 'start', tool: 'search', input: {}, lineage: { parent_call_id: callId },
      },
    }, 'session-1');
  }
  stream.handleEnvelope({
    type: 'model_request', run_id: 'run-worker-call-2', call_id: 'worker-call-2', agent_id: 'worker',
    payload: { phase: 'start', round: 1 },
  }, 'session-1');

  stream.handleEnvelope({
    type: 'agent_ended', run_id: 'run-worker-call-1', call_id: 'worker-call-1', agent_id: 'worker',
    payload: { phase: 'end', success: true, status: 'succeeded' },
  }, 'session-1');

  assert.deepEqual(Object.keys(deps.activeRun.runningModelCalls), ['worker\u0000worker-call-2']);
  assert.deepEqual(Object.keys(deps.activeRun.runningToolCalls), ['tool-worker-call-2']);
  assert.equal(deps.activeRun.runningToolCalls['tool-worker-call-2'].parent_call_id, 'worker-call-2');
  assert.equal(deps.activeRun.phase, 'parallel_running');
});

test('stream_output(first_token) 设置首 token 时间并切换为模型输出中', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.runStartedAt = 100;
  deps.llmRetryState.value = { nextAttempt: 2 };

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'stream_output',
    run_id: 'run-1',
    call_id: 'root-call',
    agent_id: 'agent',
    timestamp: 101.2,
    payload: { phase: 'first_token', elapsed_ms: 350 },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'model_streaming');
  assert.equal(deps.activeRun.firstTokenAt, 101.2);
  assert.equal(deps.activeRun.firstTokenLatencyMs, 350);
  assert.equal(deps.activeRun.latestLlmFirstTokenAt, 101.2);
  assert.equal(deps.messages.value[0].content, '');
  assert.equal(calls.clearLlmRetryState, 1);
});

test('后续 stream_output(first_token) 不覆盖 run 首 token', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.runStartedAt = 100;
  deps.activeRun.firstTokenAt = 101;
  deps.activeRun.firstTokenLatencyMs = 1000;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'stream_output',
    run_id: 'run-1',
    call_id: 'root-call',
    agent_id: 'agent',
    timestamp: 110,
    payload: { phase: 'first_token', elapsed_ms: 200 },
  }, 'session-1');

  assert.equal(deps.activeRun.firstTokenAt, 101);
  assert.equal(deps.activeRun.firstTokenLatencyMs, 1000);
  assert.equal(deps.activeRun.latestLlmFirstTokenAt, 110);
});

test('stream_output(delta) 追加内容并在缺少 first token 事件时兜底 timing', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.runStartedAt = 10;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'stream_output',
    run_id: 'run-1',
    call_id: 'root-call',
    agent_id: 'agent',
    timestamp: 10.5,
    payload: { phase: 'delta', content: 'hello' },
  }, 'session-1');

  assert.equal(deps.messages.value[0].content, 'hello');
  assert.equal(deps.activeRun.phase, 'model_streaming');
  assert.equal(deps.activeRun.lastChunkAt, 10.5);
  assert.equal(deps.activeRun.outputCharCount, 5);
  assert.equal(deps.activeRun.firstTokenAt, 10.5);
  assert.equal(deps.activeRun.firstTokenLatencyMs, 500);
});

test('root compression_summary 会插入主消息流并保留元数据', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'answer' })];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.isCompressing.value = true;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'state_sync',
    payload: {
      category: 'compression',
      detail: {
        type: 'compression_summary',
        content: '[历史摘要]\nroot summary',
        thread_key: 'root',
        conversation_scope: 'root',
        visible_to_user: true,
        run_id: 'run-root',
      },
    },
  }, 'session-1');

  assert.equal(deps.isCompressing.value, false);
  assert.equal(deps.messages.value.length, 2);
  assert.equal(deps.messages.value[0].role, 'system');
  assert.equal(deps.messages.value[0].content, '[历史摘要]\nroot summary');
  assert.equal(deps.messages.value[0].metadata.msg_type, 'context_compression_summary');
  assert.equal(deps.messages.value[0].metadata.thread_key, 'root');
  assert.equal(deps.messages.value[0].metadata.run_id, 'run-root');
  assert.equal(deps.activeRun.assistantMsgIndex, 1);
});

test('child compression_summary 不进入主消息流', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'answer' })];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.isCompressing.value = true;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'state_sync',
    payload: {
      category: 'compression',
      detail: {
        type: 'compression_summary',
        content: '[历史摘要]\nchild summary',
        thread_key: 'child:child-1',
        child_agent_id: 'child-1',
        conversation_scope: 'child',
        visible_to_user: false,
        run_id: 'run-child',
      },
    },
  }, 'session-1');

  assert.equal(deps.isCompressing.value, false);
  assert.equal(deps.messages.value.length, 1);
  assert.equal(deps.messages.value[0].content, 'answer');
  assert.equal(deps.activeRun.assistantMsgIndex, 0);
});

test('原始 interaction(required) 事件不再拥有审批或输入 UI', () => {
  const approvals = [];
  const inputs = [];
  const { deps } = createDeps({
    enqueueApproval: (_event, data) => approvals.push(data),
    showUserInput: data => inputs.push(data),
  });
  const stream = useSessionAgentClient(deps);

  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'approval-1',
    payload: { kind: 'approval', phase: 'required' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'input-1',
    payload: { kind: 'user_input', phase: 'required', prompt: 'scope?' },
  }, 'session-1');

  assert.deepEqual(approvals, []);
  assert.deepEqual(inputs, []);
  assert.equal(deps.sessionRuntime.value.state, 'idle');
});

test('session.reconnect 和 run 事件不能覆盖 suspended runtime', () => {
  const approvals = [];
  const { deps } = createDeps({
    enqueueApproval: (_event, data) => approvals.push(data),
  });
  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'session.runtime',
    payload: runtimeSnapshot('suspended', {
      allowed_actions: ['resume_run'],
      resume_interaction_id: 'approval-1',
      pending_interactions: [],
    }),
  }, 'session-1');
  stream.handleEnvelope({
    type: 'session.reconnect',
    payload: { phase: 'start', replay_source: 'durable_outbox' },
  }, 'session-1');
  stream.handleEnvelope({ type: 'run_started', run_id: 'run-1', payload: {} }, 'session-1');
  stream.handleEnvelope({
    type: 'session.reconnect',
    payload: { phase: 'end', replay_source: 'durable_outbox' },
  }, 'session-1');

  assert.equal(deps.sessionRuntime.value.state, 'suspended');
  assert.equal(deps.sessionRuntime.value.resume_interaction_id, 'approval-1');
  assert.equal(deps.activeRun.phase, 'suspended');
  assert.equal(deps.isLoading.value, true);
  assert.deepEqual(approvals, []);
});

test('刷新 suspended 会话会恢复 active run 执行树并选中工作面板', async () => {
  const { deps } = createDeps();
  const execution = useMessageExecution({
    currentSessionId: deps.currentSessionId,
    chatSdkClient: deps.chatSdkClient,
    showToast: () => {},
  });
  deps.createAssistantMessage = execution.createAssistantMessage;
  deps.applyEnvelopeToMessage = execution.applyEnvelopeToMessage;
  deps.messages.value = [{ role: 'user', content: '解读这个 nc', metadata: {} }];
  const stream = useSessionAgentClient(deps);

  stream.handleEnvelope({
    type: 'session.runtime',
    payload: runtimeSnapshot('suspended'),
  }, 'session-1');
  stream.handleEnvelope({
    type: 'agent_started',
    session_id: 'session-1',
    run_id: 'run-1',
    call_id: 'root-call',
    agent_id: 'ocean-analysis',
    payload: { phase: 'start', task: '解读这个 nc', display_name: 'Ocean Analysis' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'stream_output',
    session_id: 'session-1',
    run_id: 'run-1',
    call_id: 'root-call',
    agent_id: 'ocean-analysis',
    payload: { phase: 'intent_complete', content: '读取文件元数据', round: 0 },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'tool_call',
    session_id: 'session-1',
    run_id: 'run-1',
    call_id: 'tool-call',
    agent_id: 'ocean-analysis',
    payload: {
      tool: 'execute_skill_script',
      input: { script_name: 'inspect_nc.py' },
      phase: 'start',
      status: 'running',
      round: 0,
      lineage: { parent_call_id: 'root-call' },
    },
  }, 'session-1');

  const restored = deps.messages.value[deps.activeRun.assistantMsgIndex];
  assert.equal(restored.role, 'assistant');
  assert.equal(restored.run_id, 'run-1');
  assert.equal(restored.has_execution, true);
  assert.equal(restored.executionTree.root.agentId, 'ocean-analysis');
  assert.equal(restored.executionTree.root.rounds[0].toolCalls[0].toolName, 'execute_skill_script');
  assert.equal(deps.activeRun.phase, 'approval_waiting');

  const selection = useWorkPanelSelection({
    messages: deps.messages,
    activeRun: deps.activeRun,
    hasExecutionContent: execution.hasExecutionContent,
    ensureExecutionStepsLoaded: execution.ensureExecutionStepsLoaded,
    showToast: () => {},
  });
  await nextTick();
  assert.equal(selection.currentRunMessage.value, restored);
});

test('active run 快照断线重放前会重置半截执行投影', () => {
  const { deps } = createDeps();
  const execution = useMessageExecution({
    currentSessionId: deps.currentSessionId,
    chatSdkClient: deps.chatSdkClient,
    showToast: () => {},
  });
  deps.createAssistantMessage = execution.createAssistantMessage;
  deps.applyEnvelopeToMessage = execution.applyEnvelopeToMessage;
  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'session.runtime',
    payload: runtimeSnapshot('suspended'),
  }, 'session-1');
  const message = deps.messages.value[deps.activeRun.assistantMsgIndex];
  message.content = '半截回答';
  deps.applyEnvelopeToMessage(message, {
    type: 'tool_call',
    run_id: 'run-1',
    call_id: 'tool-1',
    agent_id: 'ocean-analysis',
    payload: { tool: 'execute_skill_script', input: {}, phase: 'start', lineage: {} },
  });
  assert.equal(message.executionTree.root !== null, true);

  stream.handleEnvelope({
    type: 'session.reconnect',
    run_id: 'run-1',
    payload: { phase: 'start', replay_count: 1, replay_source: 'active_run_snapshot' },
  }, 'session-1');

  assert.equal(message.content, '');
  assert.equal(message.executionTree.root, null);
  assert.equal(message.has_execution, false);
});

test('resume_run 使用 durable interaction 恢复，并对重复点击去重', async () => {
  let resumeRequests = 0;
  const { deps } = createDeps();
  deps.chatSdkClient.resume = async () => {
    resumeRequests += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return true;
  };
  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'session.runtime',
    payload: runtimeSnapshot('suspended', {
      allowed_actions: ['resume_run', 'stop_run'],
      resume_interaction_id: 'approval-1',
      pending_interactions: [],
    }),
  }, 'session-1');

  const [first, second] = await Promise.all([stream.resume(), stream.resume()]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(resumeRequests, 1);
});

test('resume_run 失败时由客户端收敛错误，不产生未处理 rejection', async () => {
  const { deps, calls } = createDeps();
  deps.chatSdkClient.resume = async () => { throw new Error('恢复租约已被占用'); };
  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'session.runtime',
    payload: runtimeSnapshot('suspended', {
      allowed_actions: ['resume_run', 'stop_run'],
      resume_interaction_id: 'approval-1',
      pending_interactions: [],
    }),
  }, 'session-1');

  assert.equal(await stream.resume(), false);
  assert.equal(calls.showToast.length, 1);
  assert.equal(calls.showToast[0][1], 'warning');
});

test('waiting_interaction 快照重建审批和输入 UI，重复快照保持本地操作状态', () => {
  const approvals = [];
  const inputs = [];
  const { deps } = createDeps({
    enqueueApproval: (_event, data) => approvals.push(data),
    showUserInput: data => inputs.push(data),
  });
  const snapshot = runtimeSnapshot('waiting_interaction', {
    allowed_actions: ['respond_interaction', 'stop_run'],
    pending_interactions: [
      pendingInteraction('approval', 'approval-1'),
      pendingInteraction('user_input', 'input-1'),
    ],
  });
  const stream = useSessionAgentClient(deps);

  stream.handleEnvelope({ type: 'session.runtime', payload: snapshot }, 'session-1');
  stream.handleEnvelope({
    type: 'session.runtime',
    payload: { ...snapshot, observed_at: '2026-07-30T00:00:02.000Z' },
  }, 'session-1');

  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].approval_id, 'approval-1');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].input_id, 'input-1');
  assert.equal(deps.activeRun.phase, 'approval_waiting');
});

test('后续 runtime 快照按 interaction_id 对账并关闭已消失的交互', () => {
  const approvals = [];
  const inputs = [];
  const { deps, calls } = createDeps({
    enqueueApproval: (_event, data) => approvals.push(data),
    showUserInput: data => inputs.push(data),
  });
  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'session.runtime',
    payload: runtimeSnapshot('waiting_interaction', {
      pending_interactions: [
        pendingInteraction('approval', 'approval-1'),
        pendingInteraction('user_input', 'input-1'),
      ],
    }),
  }, 'session-1');
  stream.handleEnvelope({
    type: 'session.runtime',
    payload: runtimeSnapshot('waiting_interaction', {
      pending_interactions: [pendingInteraction('approval', 'approval-1')],
    }),
  }, 'session-1');

  assert.equal(approvals.length, 1);
  assert.equal(inputs.length, 1);
  assert.deepEqual(calls.handleUserInputResolved, [['input-1']]);

  stream.handleEnvelope({ type: 'session.runtime', payload: runtimeSnapshot('idle') }, 'session-1');
  assert.deepEqual(calls.handleApprovalResolved, [['approval-1', 'session-1']]);
});

test('快照恢复的 user_input 通过 SDK 提交并等待 SDK 确认', async () => {
  const sent = [];
  let capturedSubmit = null;
  let resolveSubmit;
  const { deps } = createDeps({
    showUserInput: (_data, submit) => { capturedSubmit = submit; },
  });
  deps.chatSdkClient.respondInteraction = (...args) => {
    sent.push(args);
    return new Promise(resolve => { resolveSubmit = resolve; });
  };
  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'session.runtime',
    payload: runtimeSnapshot('waiting_interaction', {
      allowed_actions: ['respond_interaction'],
      pending_interactions: [pendingInteraction('user_input', 'input-1')],
    }),
  }, 'session-1');

  const submitPromise = capturedSubmit('input-1', 'session');
  assert.deepEqual(sent, [['input-1', { kind: 'user_input', value: 'session' }]]);
  resolveSubmit();
  await submitPromise;
});

test('resetStreamSessionState 后同一 runtime 快照可重新展示交互', () => {
  const approvals = [];
  const { deps } = createDeps({
    enqueueApproval: (_event, data) => approvals.push(data),
  });
  const snapshot = runtimeSnapshot('waiting_interaction', {
    pending_interactions: [pendingInteraction('approval', 'approval-1')],
  });
  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({ type: 'session.runtime', payload: snapshot }, 'session-1');
  stream.handleEnvelope({ type: 'session.runtime', payload: snapshot }, 'session-1');
  assert.equal(approvals.length, 1);

  stream.resetStreamSessionState();
  stream.handleEnvelope({ type: 'session.runtime', payload: snapshot }, 'session-1');
  assert.equal(approvals.length, 2);
});

test('快照恢复的 user_input 在 SDK 拒绝时提示错误', async () => {
  let capturedSubmit = null;
  const { deps, calls } = createDeps({
    showUserInput: (_data, submit) => { capturedSubmit = submit; },
  });
  deps.chatSdkClient.respondInteraction = async () => { throw new Error('not found'); };
  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'session.runtime',
    payload: runtimeSnapshot('waiting_interaction', {
      pending_interactions: [pendingInteraction('user_input', 'input-1')],
    }),
  }, 'session-1');

  await assert.rejects(capturedSubmit('input-1', 'session'), /not found/);
  assert.equal(calls.showToast[0][0], 'not found');
});

test('快照恢复的 user_input 不再拥有前端 HTTP fallback', async () => {
  let capturedSubmit = null;
  const calls = [];
  const { deps } = createDeps({
    showUserInput: (_data, submit) => { capturedSubmit = submit; },
  });
  deps.chatSdkClient.respondInteraction = async (...args) => { calls.push(args); };
  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'session.runtime',
    payload: runtimeSnapshot('waiting_interaction', {
      pending_interactions: [pendingInteraction('user_input', 'input-1')],
    }),
  }, 'session-1');
  await capturedSubmit('input-1', 'session');
  assert.deepEqual(calls, [['input-1', { kind: 'user_input', value: 'session' }]]);
});

test('连续投递 seq 不触发 gap 对账', () => {
  const { deps, calls, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  deps.messages.value = [createAssistantMessage({ content: 'partial answer' })];
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.lastSeenSeq = 1;
  deps.activeRun.phase = 'model_streaming';

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'approval-gap',
    seq: 2,
    payload: { kind: 'approval', phase: 'required' },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'model_streaming');
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);

  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'completed' } }, 'session-1');

  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);
});

test('真正的投递序号 gap 在已有最终答案时只做轻量对账', () => {
  const { deps, calls, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  deps.messages.value = [createAssistantMessage({ content: 'partial answer' })];
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.lastSeenSeq = 1;
  deps.activeRun.phase = 'model_streaming';

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'approval-gap',
    seq: 8,
    payload: { kind: 'approval', phase: 'required' },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'model_streaming');
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);

  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'completed' } }, 'session-1');

  assert.deepEqual(calls.mergeMessageIdsFromServer, [['session-1']]);
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);
});

test('mergeMessageIdsFromServer 不可用时 gap 对账回退到全量刷新', () => {
  const { deps, calls, sessionRunStore } = createDeps({ mergeMessageIdsFromServer: undefined });
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  deps.messages.value = [createAssistantMessage({ content: 'final answer' })];
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.lastSeenSeq = 1;
  deps.activeRun.phase = 'model_streaming';

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'approval-gap',
    seq: 8,
    payload: { kind: 'approval', phase: 'required' },
  }, 'session-1');
  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'completed' } }, 'session-1');

  assert.deepEqual(calls.deleteMessageCache, [['session-1']]);
  assert.deepEqual(calls.loadSessionMessages, [['session-1', { silent: true }]]);
});

test('投递序号 gap 且没有可展示答案时仍回退到全量刷新', () => {
  const { deps, calls, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.lastSeenSeq = 1;
  deps.activeRun.phase = 'model_streaming';

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'approval-gap',
    seq: 8,
    payload: { kind: 'approval', phase: 'required' },
  }, 'session-1');
  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'completed' } }, 'session-1');

  assert.deepEqual(calls.mergeMessageIdsFromServer, []);
  assert.deepEqual(calls.deleteMessageCache, [['session-1']]);
  assert.deepEqual(calls.loadSessionMessages, [['session-1', { silent: true }]]);
});


test('interaction responded 事件不能自行覆盖 runtime 驱动的等待阶段', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.phase = 'approval_waiting';

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'approval-1',
    payload: { kind: 'approval', phase: 'responded', approved: false },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'approval_waiting');
});


test('run_ended 事件收尾回答，但不会越权覆盖 Session runtime', () => {
  const { deps, calls, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  deps.messages.value = [createAssistantMessage({ content: 'final answer' })];
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'completed' } }, 'session-1');

  assert.equal(deps.sessionRuntime.value.state, 'running');
  assert.equal(deps.messages.value[0].finished, true);
  assert.equal(deps.messages.value[0].has_execution, true);
  assert.equal(deps.activeRun.active, false);
  assert.equal(deps.isLoading.value, true);
  assert.equal(calls.clearLlmRetryState, 1);
  assert.deepEqual(calls.cacheMessages, [['session-1', deps.messages.value]]);
  assert.equal(calls.updateRecentSession.length, 1);
  assert.deepEqual(calls.scrollToBottom, [[]]);
});

test('run_ended 以 interrupted/failed 终止时清空残留 approval/input 弹窗', () => {
  const { deps, calls, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  deps.messages.value = [createAssistantMessage({ content: 'partial' })];
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);

  // interrupted：后端 abort 只 reject waitForApproval 不发取消事件，前端据终态清弹窗
  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'interrupted', reason: 'session_stopped' } }, 'session-1');
  assert.equal(calls.resetApprovalState.length, 1);
  assert.equal(deps.messages.value[0].content, '本次运行已中断，未生成最终答案。原因：用户主动停止运行');
  assert.equal(deps.messages.value[0].metadata.terminal_reason, 'session_stopped');
  assert.equal(deps.messages.value[0].finished, true);
  assert.equal(deps.messages.value[0].has_execution, true);

  calls.resetApprovalState.length = 0;
  deps.messages.value[0].content = '';
  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'failed', reason: 'provider disconnected' } }, 'session-1');
  assert.equal(calls.resetApprovalState.length, 1);
  assert.equal(deps.messages.value[0].content, '本次运行执行失败：provider disconnected');
});

test('仅收到终态事件时也能定位消息并保留执行过程入口', () => {
  const { deps, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  deps.messages.value = [createAssistantMessage({ id: 'assistant-run-1', run_id: 'run-1' })];
  deps.activeRun.assistantMsgIndex = -1;
  deps.activeRun.runId = 'run-1';

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'run_ended',
    run_id: 'run-1',
    payload: { status: 'interrupted', reason: 'backend_restarted' },
  }, 'session-1');

  assert.equal(deps.messages.value[0].finished, true);
  assert.equal(deps.messages.value[0].has_execution, true);
  assert.equal(deps.messages.value[0].run_id, 'run-1');
  assert.match(deps.messages.value[0].content, /后端重启导致运行中断/);
});

test('run_ended 正常完成时不清 approval（应已 resolved）', () => {
  const { deps, calls, sessionRunStore } = createDeps();
  sessionRunStore.applySessionRuntime(runtimeSnapshot('running'));
  deps.messages.value = [createAssistantMessage({ content: 'done' })];
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'completed' } }, 'session-1');
  assert.equal(calls.resetApprovalState.length, 0);
});
