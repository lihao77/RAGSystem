import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, ref } from 'vue';
import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

import { useSessionAgentClient } from './useSessionAgentClient.js';
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

function createDeps(overrides = {}) {
  setActivePinia(createPinia());
  const sessionRunStore = useSessionRunStore();
  const {
    currentSessionId,
    messages,
    isLoading,
    isCompressing,
    contextUsage,
    sessionTaskInfo,
    llmRetryState,
  } = storeToRefs(sessionRunStore);
  currentSessionId.value = 'session-1';
  contextUsage.value = null;

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
    resetApprovalState: [],
  };

  const deps = {
    currentSessionId,
    messages,
    isLoading,
    isCompressing,
    contextUsage,
    sessionTaskInfo,
    activeRun: sessionRunStore.activeRun,
    llmRetryState,
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
    checkSituationScreenTrigger: () => {},
    findRunningExecutionAgentByAgentId: () => null,
    enqueueApproval: () => {},
    handleApprovalResolved: (...args) => { calls.handleApprovalResolved.push(args); },
    resetApprovalState: (...args) => { calls.resetApprovalState.push(args); },
    isRootEvent: () => true,
    isMasterEvent: () => true,
    applyEnvelopeToMessage: () => {},
    handleStop: async () => {},
    ...overrides,
  };

  return { deps, calls };
}

function withMock(setup, run) {
  const mock = new MockAdapter(httpClient);
  setup(mock);
  return Promise.resolve()
    .then(run)
    .finally(() => { mock.restore(); });
}

test('ack(send) 启动失败时会结束当前 assistant 占位并标记失败', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({ type: 'ack', payload: { category: 'send', ok: false, error: 'boom' } }, 'session-1');

  assert.match(deps.messages.value[0].content, /boom/);
  assert.equal(deps.messages.value[0].finished, true);
  assert.equal(deps.sessionTaskInfo.value.status, 'failed');
  assert.equal(deps.activeRun.active, false);
  assert.equal(deps.isLoading.value, false);
});

test('state_sync(command_result) 会补建 assistant 消息并触发静默刷新', async () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [{ role: 'user', content: '/foo' }];
  deps.isLoading.value = true;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'state_sync',
    payload: {
      category: 'command_result',
      detail: { content: '命令完成', command: '/foo', success: true },
    },
  }, 'session-1');
  await nextTick();

  assert.equal(deps.messages.value.length, 2);
  assert.equal(deps.messages.value[1].role, 'assistant');
  assert.equal(deps.messages.value[1].content, '命令完成');
  assert.equal(deps.messages.value[1].metadata.msg_type, 'command_result');
  assert.equal(deps.messages.value[1].metadata.command, '/foo');
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
  const { deps, calls } = createDeps();
  deps.activeRun.active = true;
  deps.isLoading.value = false;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({ type: 'state_sync', payload: { category: 'session_updated' } }, 'session-1');

  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);
});

test('已送达但由顶层处理的事件会推进 seq，避免后续输出误判 gap', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
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
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'final answer' })];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
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

test('state_sync(message_saved) 会按 request_id 合并运行中 followup 的 id 和 seq', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [
    { role: 'user', content: '原始任务', metadata: {}, attachments: [] },
    createAssistantMessage({ content: 'partial answer' }),
    {
      role: 'user',
      content: '运行中补充',
      metadata: {
        request_id: 'req-followup',
        execution_kind: 'session_followup',
        source: 'running_session',
        persistence_status: 'pending',
      },
      attachments: [],
    },
  ];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 1;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'state_sync',
    payload: {
      category: 'message_saved',
      ref: {
        message_id: 'msg-followup',
        seq: 12,
        role: 'user',
        request_id: 'req-followup',
        run_id: 'run-1',
        task_id: 'task-1',
      },
    },
  }, 'session-1');

  assert.equal(deps.messages.value[0].id, undefined);
  assert.equal(deps.messages.value[2].id, 'msg-followup');
  assert.equal(deps.messages.value[2].seq, 12);
  assert.equal(deps.messages.value[2].metadata.persistence_status, undefined);
  assert.equal(deps.messages.value[2].metadata.run_id, 'run-1');
  assert.equal(deps.messages.value[2].metadata.task_id, 'task-1');
  assert.deepEqual(calls.cacheMessages, [['session-1', deps.messages.value]]);
});

test('run_ended 会收尾 active run 并标记完成状态', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'final answer' })];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.sessionTaskInfo.value = { status: 'running' };

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'run_ended',
    payload: { status: 'completed' },
  }, 'session-1');

  assert.equal(deps.messages.value[0].finished, true);
  assert.equal(deps.activeRun.active, false);
  assert.equal(deps.sessionTaskInfo.value.status, 'completed');
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


test('run_started 初始化运行态为等待模型首 token', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'run_started',
    timestamp: 100,
    run_id: 'run-1',
  }, 'session-1');

  assert.equal(deps.activeRun.runId, 'run-1');
  assert.equal(deps.activeRun.phase, 'llm_waiting_first_token');
  assert.equal(deps.activeRun.runStartedAt, 100);
  assert.equal(deps.activeRun.firstTokenAt, null);
  assert.equal(deps.activeRun.firstTokenLatencyMs, null);
  assert.equal(deps.isLoading.value, true);
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
    timestamp: 101.2,
    payload: { phase: 'first_token', elapsed_ms: 350 },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'llm_streaming');
  assert.equal(deps.activeRun.firstTokenAt, 101.2);
  assert.equal(deps.activeRun.firstTokenLatencyMs, 350);
  assert.equal(deps.activeRun.latestLlmFirstTokenAt, 101.2);
  assert.equal(deps.activeRun.waiting, null);
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
    timestamp: 10.5,
    payload: { phase: 'delta', content: 'hello' },
  }, 'session-1');

  assert.equal(deps.messages.value[0].content, 'hello');
  assert.equal(deps.activeRun.phase, 'llm_streaming');
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

test('waiting 事件切换后台等待状态并在结束后回到等待模型响应', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'state_sync',
    timestamp: 20,
    payload: {
      category: 'waiting',
      detail: {
        phase: 'start',
        wait_id: 'wait-1',
        background_task_ids: ['bg-1'],
        pending_task_ids: ['bg-1'],
        pending_task_count: 1,
        timeout_ms: 30000,
      },
    },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'background_waiting');
  assert.equal(deps.activeRun.waiting.waitId, 'wait-1');
  assert.deepEqual(deps.activeRun.waiting.backgroundTaskIds, ['bg-1']);

  stream.handleEnvelope({
    type: 'state_sync',
    timestamp: 21,
    payload: { category: 'waiting', detail: { phase: 'end', wait_id: 'old-wait' } },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'background_waiting');
  assert.equal(deps.activeRun.waiting.waitId, 'wait-1');

  stream.handleEnvelope({
    type: 'state_sync',
    timestamp: 22,
    payload: { category: 'waiting', detail: { phase: 'end', wait_id: 'wait-1' } },
  }, 'session-1');

  assert.equal(deps.activeRun.waiting, null);
  assert.equal(deps.activeRun.phase, 'llm_waiting_first_token');
});

test('权限审批期间切换为等待权限审批并在确认后进入工具执行中', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.phase = 'llm_streaming';

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'approval-1',
    payload: { kind: 'approval', phase: 'required' },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'approval_waiting');

  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'approval-1',
    payload: { kind: 'approval', phase: 'responded', approved: true },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'tool_running');
  assert.equal(calls.handleApprovalResolved.length, 1);
});

test('user_input required 通过 WS 提交并等待 ack 后完成', async () => {
  const sent = [];
  let capturedSubmit = null;
  const { deps } = createDeps({
    showUserInput: (_data, submit) => {
      capturedSubmit = submit;
    },
    getWS: () => ({
      readyState: 1,
      send: (payload) => {
        sent.push(JSON.parse(payload));
      },
    }),
  });
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'input-1',
    payload: { kind: 'user_input', phase: 'required', prompt: 'scope?' },
  }, 'session-1');

  const submitPromise = capturedSubmit('input-1', 'session');
  assert.deepEqual(sent, [{
    type: 'interaction',
    session_id: 'session-1',
    call_id: 'input-1',
    payload: { kind: 'user_input', phase: 'responded', value: 'session' },
  }]);

  stream.handleEnvelope({
    type: 'ack',
    call_id: 'input-1',
    payload: { category: 'interaction', ok: true, ref_call_id: 'input-1' },
  }, 'session-1');

  await submitPromise;
});

test('interaction(user_input, required) 重复事件不重复展示', () => {
  const shown = [];
  const { deps } = createDeps({
    showUserInput: (data) => {
      shown.push(data);
    },
  });
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'input-1',
    payload: { kind: 'user_input', phase: 'required', prompt: 'scope?' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'input-1',
    payload: { kind: 'user_input', phase: 'required', prompt: 'scope?' },
  }, 'session-1');

  assert.equal(shown.length, 1);
  assert.equal(shown[0].input_id, 'input-1');
  assert.equal(shown[0].kind, 'user_input');
});

test('interaction(approval, required) 重复事件不重复入队', () => {
  const approvals = [];
  const { deps } = createDeps({
    enqueueApproval: (_event, data) => {
      approvals.push(data);
    },
  });
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.phase = 'llm_streaming';

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'approval-1',
    payload: { kind: 'approval', phase: 'required', tool_name: 'write_file' },
  }, 'session-1');
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'approval-1',
    payload: { kind: 'approval', phase: 'required', tool_name: 'write_file' },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'approval_waiting');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].approval_id, 'approval-1');
  assert.equal(approvals[0].kind, 'approval');
});

test('resetStreamSessionState 会清理交互去重，侧边栏切回时 pending approval 可重新展示', () => {
  const approvals = [];
  const { deps } = createDeps({
    enqueueApproval: (_event, data) => {
      approvals.push(data);
    },
  });
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.phase = 'llm_streaming';

  const stream = useSessionAgentClient(deps);
  const event = {
    type: 'interaction',
    call_id: 'approval-1',
    payload: { kind: 'approval', phase: 'required', tool_name: 'write_file' },
  };
  stream.handleEnvelope(event, 'session-1');
  stream.handleEnvelope(event, 'session-1');
  assert.equal(approvals.length, 1);

  stream.resetStreamSessionState();
  stream.handleEnvelope(event, 'session-1');

  assert.equal(approvals.length, 2);
  assert.equal(approvals[1].approval_id, 'approval-1');
});

test('user_input required 收到 ack(interaction) 失败时拒绝提交并提示', async () => {
  let capturedSubmit = null;
  const { deps, calls } = createDeps({
    showUserInput: (_data, submit) => {
      capturedSubmit = submit;
    },
    getWS: () => ({
      readyState: 1,
      send: () => {},
    }),
  });
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'input-1',
    payload: { kind: 'user_input', phase: 'required', prompt: 'scope?' },
  }, 'session-1');

  const submitPromise = capturedSubmit('input-1', 'session');
  stream.handleEnvelope({
    type: 'ack',
    call_id: 'input-1',
    payload: { category: 'interaction', ok: false, error: 'not found', ref_call_id: 'input-1' },
  }, 'session-1');

  await assert.rejects(submitPromise, /not found/);
  assert.equal(calls.showToast.length, 1);
  assert.equal(calls.showToast[0][0], 'not found');
});

test('user.input_required 在 WS 发送失败时降级 HTTP respond 路由', async () => {
  let capturedSubmit = null;
  const { deps } = createDeps({
    showUserInput: (_data, submit) => {
      capturedSubmit = submit;
    },
    getWS: () => ({
      readyState: 1,
      send: () => {
        throw new Error('WS send failed');
      },
    }),
  });
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  await withMock((mock) => {
    mock.onPost(/\/interactions\/[^/]+\/respond$/).reply((config) => {
      assert.equal(config.url, '/api/agent/sessions/session-1/interactions/input-1/respond');
      assert.equal(config.method, 'post');
      assert.deepEqual(JSON.parse(config.data), { kind: 'user_input', value: 'session' });
      return [200, {}];
    });
  }, async () => {
    const stream = useSessionAgentClient(deps);
    stream.handleEnvelope({
      type: 'interaction',
      call_id: 'input-1',
      payload: { kind: 'user_input', phase: 'required', prompt: 'scope?' },
    }, 'session-1');

    assert.equal(typeof capturedSubmit, 'function');
    await capturedSubmit('input-1', 'session');
  });
});

test('连续投递 seq 不触发 gap 对账', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'partial answer' })];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.lastSeenSeq = 1;
  deps.activeRun.phase = 'llm_streaming';
  deps.sessionTaskInfo.value = { status: 'running' };

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'approval-gap',
    seq: 2,
    payload: { kind: 'approval', phase: 'required' },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'approval_waiting');
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);

  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'completed' } }, 'session-1');

  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);
});

test('真正的投递序号 gap 在已有最终答案时只做轻量对账', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'partial answer' })];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.lastSeenSeq = 1;
  deps.activeRun.phase = 'llm_streaming';
  deps.sessionTaskInfo.value = { status: 'running' };

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({
    type: 'interaction',
    call_id: 'approval-gap',
    seq: 8,
    payload: { kind: 'approval', phase: 'required' },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'approval_waiting');
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);

  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'completed' } }, 'session-1');

  assert.deepEqual(calls.mergeMessageIdsFromServer, [['session-1']]);
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);
});

test('mergeMessageIdsFromServer 不可用时 gap 对账回退到全量刷新', () => {
  const { deps, calls } = createDeps({ mergeMessageIdsFromServer: undefined });
  deps.messages.value = [createAssistantMessage({ content: 'final answer' })];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.lastSeenSeq = 1;
  deps.activeRun.phase = 'llm_streaming';

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
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.lastSeenSeq = 1;
  deps.activeRun.phase = 'llm_streaming';

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


test('拒绝权限审批后回到等待模型响应', () => {
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

  assert.equal(deps.activeRun.phase, 'llm_waiting_first_token');
});


test('run_ended 事件会收尾 active run 并刷新执行态', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'final answer' })];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.sessionTaskInfo.value = { status: 'running' };

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'completed' } }, 'session-1');

  assert.equal(deps.sessionTaskInfo.value.status, 'completed');
  assert.equal(deps.sessionTaskInfo.value.thread_alive, false);
  assert.equal(deps.messages.value[0].finished, true);
  assert.equal(deps.activeRun.active, false);
  assert.equal(deps.isLoading.value, false);
  assert.equal(calls.clearLlmRetryState, 1);
  assert.deepEqual(calls.cacheMessages, [['session-1', deps.messages.value]]);
  assert.equal(calls.updateRecentSession.length, 1);
  assert.deepEqual(calls.scrollToBottom, [[]]);
});

test('run_ended 以 interrupted/failed 终止时清空残留 approval/input 弹窗', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'partial' })];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);

  // interrupted：后端 abort 只 reject waitForApproval 不发取消事件，前端据终态清弹窗
  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'interrupted' } }, 'session-1');
  assert.equal(calls.resetApprovalState.length, 1);

  calls.resetApprovalState.length = 0;
  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'failed' } }, 'session-1');
  assert.equal(calls.resetApprovalState.length, 1);
});

test('run_ended 正常完成时不清 approval（应已 resolved）', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'done' })];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionAgentClient(deps);
  stream.handleEnvelope({ type: 'run_ended', payload: { status: 'completed' } }, 'session-1');
  assert.equal(calls.resetApprovalState.length, 0);
});
