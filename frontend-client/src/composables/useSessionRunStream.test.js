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
  };

  const deps = {
    currentSessionId: ref('session-1'),
    messages: ref([]),
    isLoading: ref(false),
    isCompressing: ref(false),
    contextUsage: ref(null),
    sessionTaskInfo: ref(null),
    activeRun: { active: false, assistantMsgIndex: -1, runId: null, lastSeenSeq: 0, isReplaying: false },
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
    handleApprovalResolved: () => {},
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
