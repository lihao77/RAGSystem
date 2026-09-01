// 回归：后台任务通知卡不得重复渲染。
// 根因：persister 的 initialRecords 把 message_saved 排在 run_started 之前（实时流），
// 且 active_run_snapshot / durable 回放会重发 run_started——两种顺序下 run_started 分支
// 都可能再插一张无 id 合成卡。修复：合成前按 source+request_id/run_id 去重；
// reconcileParticipantMessages 对系统通知卡支持无 id 合并。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

import { useSessionRunStore } from '../stores/session-run.js';
import { createSessionEnvelopeDispatcher } from './sessionEnvelopeDispatcher.js';

function createDispatcherFixture() {
  const store = useSessionRunStore();
  const { messages } = storeToRefs(store);
  const state = {
    currentSessionId: { value: 'session-1' },
    messages,
    isLoading: { value: false },
    isCompressing: { value: false },
    contextUsage: { value: { used: 0, max: 0, source: 'none' } },
    llmRetryState: { value: null },
    activeRun: {
      active: false,
      assistantMsgIndex: -1,
      runId: null,
      phase: 'idle',
      lastSeenSeq: 0,
      isReplaying: false,
      runStartedAt: null,
      runningToolCalls: {},
      runningModelCalls: {},
      rootCallId: null,
    },
  };
  const runtime = {
    observeDeliverySeq: () => {},
    isDurableReplayActive: () => false,
    isActiveRunSnapshotReplayEnvelope: () => false,
    isDurableOutboxReplayEnvelope: () => false,
    resetActiveRunPresentation: () => {},
    setDurableReplay: () => {},
    resetPendingReconciliation: () => {},
    startActiveRunRuntime: () => {},
    handleInactiveDurableReplayEvent: () => false,
  };
  const dispatcher = createSessionEnvelopeDispatcher({
    deps: {
      createAssistantMessage: (overrides = {}) => ({
        role: 'assistant',
        content: '',
        status: [],
        finished: false,
        ...overrides,
        metadata: { ...(overrides.metadata || {}) },
      }),
      scrollToBottom: () => {},
      showToast: () => {},
      cacheMessages: () => {},
      enqueueApproval: () => {},
      updateRecentSession: () => {},
    },
    state,
    runtime,
    recovery: { clearCommandFallback: () => {}, scheduleCommandFallback: () => {} },
    interaction: { reset: () => {}, hasPending: () => false, resolve: () => {}, reject: () => {} },
    applySessionRuntime: () => {},
    finishPendingCommand: () => {},
    reorderMessages: () => {},
    onRuntimeSnapshot: () => {},
    getStop: () => () => {},
  });
  return { dispatcher, messages };
}

const bgRunStarted = {
  type: 'run_started',
  session_id: 'session-1',
  run_id: 'run-bg-1',
  payload: {
    request_id: 'bg_notify_1',
    task: '<task-notification>task done</task-notification>',
    source: 'system.bg_notification',
  },
};

test('run_started 重放不重复插入通知合成卡', () => {
  setActivePinia(createPinia());
  const { dispatcher, messages } = createDispatcherFixture();

  dispatcher.handleEnvelope(bgRunStarted, 'session-1');
  assert.equal(messages.value.filter(item => item.role === 'user'
    && item.metadata?.source === 'background_notification').length, 1);

  // 同一 run_started 的重复投递（active_run_snapshot / durable 回放会重发；去重靠
  // request_id/run_id 命中，与 replay_source 标记本身无关）。
  dispatcher.handleEnvelope({ ...bgRunStarted, payload: { ...bgRunStarted.payload, replay_source: 'active_run_snapshot' } }, 'session-1');
  const cards = messages.value.filter(item => item.role === 'user'
    && item.metadata?.source === 'background_notification');
  assert.equal(cards.length, 1, '同一通知只应有一张卡');
  assert.equal(cards[0].metadata.request_id, 'bg_notify_1');
});

test('run_started 合成卡与历史持久化卡只保留一张', () => {
  setActivePinia(createPinia());
  const { dispatcher, messages } = createDispatcherFixture();

  // 历史加载已返回持久化通知行（有 id/seq，metadata 带 request_id/run_id）。
  messages.value.push({
    role: 'user',
    id: 'msg-1',
    seq: 7,
    content: '<task-notification>task done</task-notification>',
    finished: true,
    run_id: 'run-bg-1',
    metadata: {
      source: 'background_notification',
      request_id: 'bg_notify_1',
      run_id: 'run-bg-1',
      consumed_by_run_id: 'run-bg-1',
    },
  });

  dispatcher.handleEnvelope(bgRunStarted, 'session-1');
  const cards = messages.value.filter(item => item.role === 'user'
    && item.metadata?.source === 'background_notification');
  assert.equal(cards.length, 1, '已有持久化卡时不得再插入合成卡');
  assert.equal(cards[0].id, 'msg-1');
});

test('实时顺序（message_saved 先于 run_started 落库投递）只出一张卡', () => {
  setActivePinia(createPinia());
  const { dispatcher, messages } = createDispatcherFixture();

  // persister 的 initialRecords 把 message_saved 排在 run_started 之前：后台通知 run
  // 启动时前端先收到持久化用户行的 message_saved（按 ref 建卡），再收到 run_started。
  dispatcher.handleEnvelope({
    type: 'state_sync',
    session_id: 'session-1',
    run_id: 'run-bg-1',
    payload: {
      category: 'message_saved',
      ref: {
        message_id: 'msg-1',
        seq: 7,
        role: 'user',
        request_id: 'bg_notify_1',
        content_parts: [{ type: 'text', text: '<task-notification>task done</task-notification>' }],
        metadata: {
          source: 'background_notification',
          request_id: 'bg_notify_1',
          run_id: 'run-bg-1',
          consumed_by_run_id: 'run-bg-1',
        },
      },
    },
  }, 'session-1');

  dispatcher.handleEnvelope(bgRunStarted, 'session-1');

  const cards = messages.value.filter(item => item.role === 'user'
    && item.metadata?.source === 'background_notification');
  assert.equal(cards.length, 1, 'message_saved 建卡后 run_started 不得再插合成卡');
  assert.equal(cards[0].id, 'msg-1');
});

test('不同任务的通知卡互不去重', () => {
  setActivePinia(createPinia());
  const { dispatcher, messages } = createDispatcherFixture();

  dispatcher.handleEnvelope(bgRunStarted, 'session-1');
  dispatcher.handleEnvelope({
    ...bgRunStarted,
    run_id: 'run-bg-2',
    payload: { ...bgRunStarted.payload, request_id: 'bg_notify_2' },
  }, 'session-1');

  assert.equal(messages.value.filter(item => item.role === 'user'
    && item.metadata?.source === 'background_notification').length, 2);
});

test('reconcileParticipantMessages 把无 id 合成卡并入持久化卡', () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.setParticipantMessages('root', [{
    role: 'user',
    content: '<task-notification>task done</task-notification>',
    finished: true,
    metadata: { source: 'background_notification', request_id: 'bg_notify_1', run_id: 'run-bg-1' },
  }]);

  const next = store.reconcileParticipantMessages('root', [{
    role: 'user',
    id: 'msg-1',
    seq: 7,
    content: '<task-notification>task done</task-notification>',
    finished: true,
    metadata: {
      source: 'background_notification',
      request_id: 'bg_notify_1',
      run_id: 'run-bg-1',
      consumed_by_run_id: 'run-bg-1',
    },
  }]);

  assert.equal(next.length, 1);
  assert.equal(next[0].id, 'msg-1');
  assert.equal(next[0].seq, 7);
});
