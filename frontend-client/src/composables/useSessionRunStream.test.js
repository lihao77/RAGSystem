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
