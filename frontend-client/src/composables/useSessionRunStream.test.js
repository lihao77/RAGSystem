import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, ref } from 'vue';

import { useSessionRunStream } from './useSessionRunStream.js';

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

function createDeps(overrides = {}) {
  const calls = {
    clearCommandFallback: 0,
    deleteMessageCache: [],
    loadSessionMessages: [],
    mergeMessageIdsFromServer: [],
    refreshSessionExecutionState: [],
    cacheMessages: [],
    updateRecentSession: [],
    scrollToBottom: [],
    showToast: [],
    clearLlmRetryState: 0,
    handleApprovalResolved: [],
  };

  const deps = {
    currentSessionId: ref('session-1'),
    messages: ref([]),
    isLoading: ref(false),
    isCompressing: ref(false),
    contextUsage: ref(null),
    sessionTaskInfo: ref(null),
    activeRun: {
      active: false,
      assistantMsgIndex: -1,
      runId: null,
      lastSeenSeq: 0,
      isReplaying: false,
      phase: 'idle',
      runStartedAt: null,
      firstTokenAt: null,
      firstTokenLatencyMs: null,
      latestLlmFirstTokenAt: null,
      lastChunkAt: null,
      waiting: null,
      outputCharCount: 0,
    },
    llmRetryState: ref(null),
    userInputDialogRef: ref(null),
    getWS: () => null,
    createAssistantMessage,
    clearSessionResumeRecovery: () => {},
    clearCommandFallback: () => { calls.clearCommandFallback += 1; },
    scheduleCommandFallback: () => {},
    deleteMessageCache: (...args) => { calls.deleteMessageCache.push(args); },
    loadSessionMessages: (...args) => { calls.loadSessionMessages.push(args); },
    mergeMessageIdsFromServer: (...args) => { calls.mergeMessageIdsFromServer.push(args); },
    refreshSessionExecutionState: (...args) => { calls.refreshSessionExecutionState.push(args); },
    mergeExecutionObservability: () => {},
    cacheMessages: (...args) => { calls.cacheMessages.push(args); },
    clearLlmRetryState: () => { calls.clearLlmRetryState += 1; },
    scrollToBottom: (...args) => { calls.scrollToBottom.push(args); },
    showToast: (...args) => { calls.showToast.push(args); },
    setLlmRetryState: () => {},
    updateRecentSession: (...args) => { calls.updateRecentSession.push(args); },
    checkSituationScreenTrigger: () => {},
    ensureExecutionProjector: () => ({}),
    syncExecutionProjection: () => {},
    findSubtaskByCallId: () => null,
    findRunningSubtaskByAgentName: () => null,
    enqueueApproval: () => {},
    handleApprovalResolved: (...args) => { calls.handleApprovalResolved.push(args); },
    buildTaskNotificationMessage: () => ({ role: 'user', metadata: { source: 'system.bg_notification' } }),
    isRootEvent: () => true,
    isMasterEvent: () => true,
    applyStep: () => {},
    handleStop: async () => {},
    ...overrides,
  };

  return { deps, calls };
}

test('send.ack 启动失败时会结束当前 assistant 占位并标记失败', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({ type: 'send.ack', started: false, error: 'boom' }, 'session-1');

  assert.match(deps.messages.value[0].content, /boom/);
  assert.equal(deps.messages.value[0].finished, true);
  assert.equal(deps.sessionTaskInfo.value.status, 'failed');
  assert.equal(deps.activeRun.active, false);
  assert.equal(deps.isLoading.value, false);
  assert.equal(calls.clearCommandFallback, 1);
});

test('command.result 会补建 assistant 消息并触发静默刷新', async () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [{ role: 'user', content: '/foo' }];
  deps.isLoading.value = true;

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'command.result',
    data: { content: '命令完成', command: '/foo', success: true },
  }, 'session-1');
  await nextTick();

  assert.equal(deps.messages.value.length, 2);
  assert.equal(deps.messages.value[1].role, 'assistant');
  assert.equal(deps.messages.value[1].content, '命令完成');
  assert.equal(deps.messages.value[1].metadata.type, 'command_result');
  assert.equal(deps.messages.value[1].metadata.command, '/foo');
  assert.equal(deps.messages.value[1].finished, true);
  assert.equal(deps.isLoading.value, false);
  assert.deepEqual(calls.deleteMessageCache, [['session-1']]);
  assert.deepEqual(calls.loadSessionMessages, [['session-1', { silent: true }]]);
  assert.deepEqual(calls.scrollToBottom, [[true]]);
});

test('session.updated 在非执行态会触发消息刷新', () => {
  const { deps, calls } = createDeps();

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({ type: 'session.updated' }, 'session-1');

  assert.deepEqual(calls.deleteMessageCache, [['session-1']]);
  assert.deepEqual(calls.loadSessionMessages, [['session-1', { silent: true }]]);
});

test('session.updated 在 active run 期间不重拉消息', () => {
  const { deps, calls } = createDeps();
  deps.activeRun.active = true;
  deps.isLoading.value = false;

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({ type: 'session.updated' }, 'session-1');

  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);
});

test('已送达但由顶层处理的事件会推进 stream_seq，避免后续输出误判 gap', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.lastSeenSeq = 1;

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({ type: 'send.ack', started: true, run_id: 'run-1', stream_seq: 2 }, 'session-1');
  stream.handleWSMessage({ type: 'output.chunk', data: { content: 'hello' }, stream_seq: 3 }, 'session-1');
  stream.handleWSMessage({ type: 'done', stream_seq: 4 }, 'session-1');

  assert.equal(deps.messages.value[0].content, 'hello');
  assert.deepEqual(calls.mergeMessageIdsFromServer, []);
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);
});

test('刚完成的同一 run 收到 session.updated 不重拉整条消息列表', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'final answer' })];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.runId = 'run-1';

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({ type: 'done' }, 'session-1');
  stream.handleWSMessage({ type: 'session.updated', data: { run_id: 'run-1' } }, 'session-1');

  assert.deepEqual(calls.mergeMessageIdsFromServer, [['session-1']]);
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);
  assert.deepEqual(calls.refreshSessionExecutionState, [
    ['session-1', { silent: true }],
    ['session-1', { silent: true }],
  ]);
});

test('output.final_answer 会合并 metadata 并保留已有字段', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage({
    content: 'final answer',
    metadata: { run_id: 'run-1', existing: true },
  })];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'output.final_answer',
    data: { metadata: { execution_time: 2.5, first_token_time: 0.42 } },
  }, 'session-1');

  assert.equal(deps.messages.value[0].metadata.run_id, 'run-1');
  assert.equal(deps.messages.value[0].metadata.existing, true);
  assert.equal(deps.messages.value[0].metadata.execution_time, 2.5);
  assert.equal(deps.messages.value[0].metadata.first_token_time, 0.42);
  assert.equal(deps.messages.value[0].finished, true);
});

test('output.message_saved 会按 request_id 合并运行中 followup 的 id 和 seq', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [
    { role: 'user', content: '原始任务', metadata: {}, attachments: [] },
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
    createAssistantMessage({ content: 'partial answer' }),
  ];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 2;

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'output.message_saved',
    data: {
      id: 'msg-followup',
      seq: 12,
      role: 'user',
      request_id: 'req-followup',
      run_id: 'run-1',
      task_id: 'task-1',
    },
  }, 'session-1');

  assert.equal(deps.messages.value[0].id, undefined);
  assert.equal(deps.messages.value[1].id, 'msg-followup');
  assert.equal(deps.messages.value[1].seq, 12);
  assert.equal(deps.messages.value[1].metadata.persistence_status, undefined);
  assert.equal(deps.messages.value[1].metadata.run_id, 'run-1');
  assert.equal(deps.messages.value[1].metadata.task_id, 'task-1');
  assert.deepEqual(calls.cacheMessages, [['session-1', deps.messages.value]]);
});

test('run.end 会把执行时间写入当前 assistant metadata 并收尾', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'final answer' })];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.sessionTaskInfo.value = { status: 'running' };

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'run.end',
    data: { metadata: { execution_time: '3.25', first_token_time: '0.75' } },
  }, 'session-1');

  assert.equal(deps.messages.value[0].metadata.execution_time, 3.25);
  assert.equal(deps.messages.value[0].metadata.first_token_time, 0.75);
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

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'reconnect_start',
    run_id: 'run-1',
    replay_source: 'durable_outbox',
    replay_count: 1,
  }, 'session-1');
  stream.handleWSMessage({
    type: 'run.end',
    run_id: 'run-1',
    replay_source: 'durable_outbox',
    data: { status: 'completed', metadata: { execution_time: 1.2 } },
  }, 'session-1');
  stream.handleWSMessage({
    type: 'reconnect_end',
    replay_source: 'durable_outbox',
  }, 'session-1');

  assert.equal(deps.messages.value.length, 1);
  assert.equal(deps.messages.value[0].content, '已加载的回答');
  assert.equal(deps.activeRun.active, false);
  assert.equal(deps.activeRun.isReplaying, false);
  assert.equal(deps.isLoading.value, false);
  assert.equal(deps.sessionTaskInfo.value.status, 'completed');
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);
  assert.deepEqual(calls.refreshSessionExecutionState, [['session-1', { silent: true }]]);
});

test('durable outbox replay 只有真实 run 事件才懒恢复 activeRun 并收尾', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [{ role: 'user', content: 'hello', metadata: { request_id: 'req-1' } }];

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'reconnect_start',
    run_id: 'run-1',
    replay_source: 'durable_outbox',
    replay_count: 5,
  }, 'session-1');

  assert.equal(deps.messages.value.length, 1);
  assert.equal(deps.activeRun.active, false);

  stream.handleWSMessage({
    type: 'session.run_started',
    run_id: 'run-1',
    data: { run_id: 'run-1' },
    replay_source: 'durable_outbox',
  }, 'session-1');
  stream.handleWSMessage({
    type: 'output.chunk',
    run_id: 'run-1',
    data: { content: 'hello ' },
    replay_source: 'durable_outbox',
  }, 'session-1');
  stream.handleWSMessage({
    type: 'output.final_answer',
    run_id: 'run-1',
    data: { content: 'hello world', metadata: { execution_time: 2.5 } },
    replay_source: 'durable_outbox',
  }, 'session-1');
  stream.handleWSMessage({
    type: 'output.message_saved',
    run_id: 'run-1',
    data: { id: 'msg-1', seq: 2, role: 'assistant', run_id: 'run-1' },
    replay_source: 'durable_outbox',
  }, 'session-1');
  stream.handleWSMessage({
    type: 'run.end',
    run_id: 'run-1',
    data: { status: 'completed', metadata: { execution_time: 2.5 } },
    replay_source: 'durable_outbox',
  }, 'session-1');
  stream.handleWSMessage({
    type: 'reconnect_end',
    replay_source: 'durable_outbox',
  }, 'session-1');

  const assistant = deps.messages.value.find(msg => msg.role === 'assistant');
  assert.equal(assistant.content, 'hello world');
  assert.equal(assistant.finished, true);
  assert.equal(assistant.id, 'msg-1');
  assert.equal(assistant.seq, 2);
  assert.equal(assistant.metadata.run_id, 'run-1');
  assert.equal(assistant.metadata.execution_time, 2.5);
  assert.equal(deps.activeRun.active, false);
  assert.equal(deps.activeRun.isReplaying, false);
  assert.equal(deps.isLoading.value, false);
  assert.deepEqual(calls.loadSessionMessages, []);
});


test('session.run_started 初始化运行态为等待模型首 token', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'session.run_started',
    timestamp: 100,
    data: { run_id: 'run-1' },
  }, 'session-1');

  assert.equal(deps.activeRun.runId, 'run-1');
  assert.equal(deps.activeRun.phase, 'llm_waiting_first_token');
  assert.equal(deps.activeRun.runStartedAt, 100);
  assert.equal(deps.activeRun.firstTokenAt, null);
  assert.equal(deps.activeRun.firstTokenLatencyMs, null);
  assert.equal(deps.isLoading.value, true);
});

test('llm.first_token 设置首 token 时间并切换为模型输出中', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.runStartedAt = 100;
  deps.llmRetryState.value = { nextAttempt: 2 };

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'llm.first_token',
    timestamp: 101.2,
    data: { elapsed_ms: 350, content_length: 4 },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'llm_streaming');
  assert.equal(deps.activeRun.firstTokenAt, 101.2);
  assert.equal(deps.activeRun.firstTokenLatencyMs, 350);
  assert.equal(deps.activeRun.latestLlmFirstTokenAt, 101.2);
  assert.equal(deps.activeRun.waiting, null);
  assert.equal(deps.messages.value[0].content, '');
  assert.equal(calls.clearLlmRetryState, 1);
});

test('后续 llm.first_token 不覆盖 run 首 token', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.runStartedAt = 100;
  deps.activeRun.firstTokenAt = 101;
  deps.activeRun.firstTokenLatencyMs = 1000;

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'llm.first_token',
    timestamp: 110,
    data: { elapsed_ms: 200 },
  }, 'session-1');

  assert.equal(deps.activeRun.firstTokenAt, 101);
  assert.equal(deps.activeRun.firstTokenLatencyMs, 1000);
  assert.equal(deps.activeRun.latestLlmFirstTokenAt, 110);
});

test('output.chunk 追加内容并在缺少 first token 事件时兜底 timing', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.runStartedAt = 10;

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'output.chunk',
    timestamp: 10.5,
    data: { content: 'hello' },
  }, 'session-1');

  assert.equal(deps.messages.value[0].content, 'hello');
  assert.equal(deps.activeRun.phase, 'llm_streaming');
  assert.equal(deps.activeRun.lastChunkAt, 10.5);
  assert.equal(deps.activeRun.outputCharCount, 5);
  assert.equal(deps.activeRun.firstTokenAt, 10.5);
  assert.equal(deps.activeRun.firstTokenLatencyMs, 500);
});

test('root context.compression_summary 会插入主消息流并保留元数据', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'answer' })];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.isCompressing.value = true;

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'context.compression_summary',
    data: {
      content: '[历史摘要]\nroot summary',
      thread_key: 'root',
      conversation_scope: 'root',
      visible_to_user: true,
      run_id: 'run-root',
    },
  }, 'session-1');

  assert.equal(deps.isCompressing.value, false);
  assert.equal(deps.messages.value.length, 2);
  assert.equal(deps.messages.value[0].role, 'system');
  assert.equal(deps.messages.value[0].content, '[历史摘要]\nroot summary');
  assert.equal(deps.messages.value[0].metadata.compression, true);
  assert.equal(deps.messages.value[0].metadata.thread_key, 'root');
  assert.equal(deps.messages.value[0].metadata.run_id, 'run-root');
  assert.equal(deps.activeRun.assistantMsgIndex, 1);
});

test('child context.compression_summary 不进入主消息流', () => {
  const { deps } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'answer' })];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.isCompressing.value = true;

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'context.compression_summary',
    data: {
      content: '[历史摘要]\nchild summary',
      thread_key: 'child:child-1',
      child_agent_id: 'child-1',
      conversation_scope: 'child',
      visible_to_user: false,
      run_id: 'run-child',
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

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'execution.waiting_start',
    timestamp: 20,
    data: {
      wait_id: 'wait-1',
      background_task_ids: ['bg-1'],
      pending_task_ids: ['bg-1'],
      pending_task_count: 1,
      timeout_ms: 30000,
    },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'background_waiting');
  assert.equal(deps.activeRun.waiting.waitId, 'wait-1');
  assert.deepEqual(deps.activeRun.waiting.backgroundTaskIds, ['bg-1']);

  stream.handleWSMessage({
    type: 'execution.waiting_end',
    timestamp: 21,
    data: { wait_id: 'old-wait', status: 'completed' },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'background_waiting');
  assert.equal(deps.activeRun.waiting.waitId, 'wait-1');

  stream.handleWSMessage({
    type: 'execution.waiting_end',
    timestamp: 22,
    data: { wait_id: 'wait-1', status: 'completed' },
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

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'user.approval_required',
    data: { approval_id: 'approval-1' },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'approval_waiting');

  stream.handleWSMessage({
    type: 'user.approval_granted',
    data: { approval_id: 'approval-1' },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'tool_running');
  assert.equal(calls.handleApprovalResolved.length, 1);
});

test('user.input_required 通过 WS 提交并等待 ack 后完成', async () => {
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

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'user.input_required',
    data: { input_id: 'input-1', prompt: 'scope?' },
  }, 'session-1');

  const submitPromise = capturedSubmit('input-1', 'session');
  assert.deepEqual(sent, [{ type: 'interaction.respond', interaction_id: 'input-1', kind: 'user_input', value: 'session' }]);

  stream.handleWSMessage({
    type: 'interaction.ack',
    interaction_id: 'input-1',
    kind: 'user_input',
    data: { interaction_id: 'input-1', kind: 'user_input', resolved: true },
  }, 'session-1');

  await submitPromise;
});

test('interaction.required 用户输入事件会兼容旧 required 事件且不重复展示', () => {
  const shown = [];
  const { deps } = createDeps({
    showUserInput: (data) => {
      shown.push(data);
    },
  });
  deps.messages.value = [createAssistantMessage()];
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'interaction.required',
    data: { interaction_id: 'input-1', kind: 'user_input', prompt: 'scope?' },
  }, 'session-1');
  stream.handleWSMessage({
    type: 'user.input_required',
    data: { interaction_id: 'input-1', input_id: 'input-1', prompt: 'scope?' },
  }, 'session-1');

  assert.equal(shown.length, 1);
  assert.equal(shown[0].input_id, 'input-1');
  assert.equal(shown[0].kind, 'user_input');
});

test('interaction.required 审批事件会兼容旧 required 事件且不重复入队', () => {
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

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'interaction.required',
    data: { interaction_id: 'approval-1', kind: 'approval', tool_name: 'write_file' },
  }, 'session-1');
  stream.handleWSMessage({
    type: 'user.approval_required',
    data: { interaction_id: 'approval-1', approval_id: 'approval-1', tool_name: 'write_file' },
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

  const stream = useSessionRunStream(deps);
  const event = {
    type: 'interaction.required',
    data: { interaction_id: 'approval-1', kind: 'approval', tool_name: 'write_file' },
  };
  stream.handleWSMessage(event, 'session-1');
  stream.handleWSMessage(event, 'session-1');
  assert.equal(approvals.length, 1);

  stream.resetStreamSessionState();
  stream.handleWSMessage(event, 'session-1');

  assert.equal(approvals.length, 2);
  assert.equal(approvals[1].approval_id, 'approval-1');
});

test('user.input_required 收到 WS error 时拒绝提交并提示', async () => {
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

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'user.input_required',
    data: { input_id: 'input-1', prompt: 'scope?' },
  }, 'session-1');

  const submitPromise = capturedSubmit('input-1', 'session');
  stream.handleWSMessage({
    type: 'interaction.error',
    interaction_id: 'input-1',
    kind: 'user_input',
    error: 'not found',
  }, 'session-1');

  await assert.rejects(submitPromise, /not found/);
  assert.equal(calls.showToast.length, 1);
  assert.equal(calls.showToast[0][0], 'not found');
});

test('user.input_required 在 WS 发送失败时降级 HTTP respond 路由', async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
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
  globalThis.fetch = async (...args) => {
    fetchCalls.push(args);
    return { ok: true };
  };

  try {
    const stream = useSessionRunStream(deps);
    stream.handleWSMessage({
      type: 'user.input_required',
      data: { input_id: 'input-1', prompt: 'scope?' },
    }, 'session-1');

    assert.equal(typeof capturedSubmit, 'function');
    await capturedSubmit('input-1', 'session');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0][0], '/api/agent/sessions/session-1/interactions/input-1/respond');
    assert.equal(fetchCalls[0][1].method, 'POST');
    assert.equal(fetchCalls[0][1].body, JSON.stringify({ kind: 'user_input', value: 'session' }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('全局 seq 跳号不会再误判为 gap', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'partial answer' })];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.activeRun.lastSeenSeq = 1;
  deps.activeRun.phase = 'llm_streaming';
  deps.sessionTaskInfo.value = { status: 'running' };

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'user.approval_required',
    seq: 8,
    stream_seq: 2,
    data: { approval_id: 'approval-gap' },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'approval_waiting');
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);

  stream.handleWSMessage({ type: 'done' }, 'session-1');

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

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'user.approval_required',
    stream_seq: 8,
    data: { approval_id: 'approval-gap' },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'approval_waiting');
  assert.deepEqual(calls.deleteMessageCache, []);
  assert.deepEqual(calls.loadSessionMessages, []);

  stream.handleWSMessage({ type: 'done' }, 'session-1');

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

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'user.approval_required',
    stream_seq: 8,
    data: { approval_id: 'approval-gap' },
  }, 'session-1');
  stream.handleWSMessage({ type: 'done' }, 'session-1');

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

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'user.approval_required',
    stream_seq: 8,
    data: { approval_id: 'approval-gap' },
  }, 'session-1');
  stream.handleWSMessage({ type: 'done' }, 'session-1');

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

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({
    type: 'user.approval_denied',
    data: { approval_id: 'approval-1' },
  }, 'session-1');

  assert.equal(deps.activeRun.phase, 'llm_waiting_first_token');
});


test('done 事件会收尾 active run 并刷新执行态', () => {
  const { deps, calls } = createDeps();
  deps.messages.value = [createAssistantMessage({ content: 'final answer' })];
  deps.isLoading.value = true;
  deps.activeRun.active = true;
  deps.activeRun.assistantMsgIndex = 0;
  deps.sessionTaskInfo.value = { status: 'running' };

  const stream = useSessionRunStream(deps);
  stream.handleWSMessage({ type: 'done' }, 'session-1');

  assert.equal(deps.sessionTaskInfo.value.status, 'completed');
  assert.equal(deps.sessionTaskInfo.value.thread_alive, false);
  assert.equal(deps.messages.value[0].finished, true);
  assert.equal(deps.activeRun.active, false);
  assert.equal(deps.isLoading.value, false);
  assert.equal(calls.clearLlmRetryState, 1);
  assert.deepEqual(calls.cacheMessages, [['session-1', deps.messages.value]]);
  assert.equal(calls.updateRecentSession.length, 1);
  assert.deepEqual(calls.refreshSessionExecutionState, [['session-1', { silent: true }]]);
  assert.deepEqual(calls.scrollToBottom, [[]]);
});
