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
      deleteMessageCache: () => {},
      loadSessionMessages: () => {},
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
  return { dispatcher, messages, state };
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

// 回归：压缩进度帧是会话级状态，不得依赖消息载体——无活动 run 的会话
// （assistantMsgIndex=-1，如刚打开就 /compact）下通用路由会丢弃这些帧。
// 摘要正文不进消息流（列表完整渲染原始对话），帧只驱动呼吸点。
test('compression frames light the indicator without inserting a card and without an active run', () => {
  setActivePinia(createPinia());
  const { dispatcher, messages, state } = createDispatcherFixture();

  dispatcher.handleEnvelope({
    type: 'state_sync',
    session_id: 'session-1',
    payload: { category: 'compression', detail: { type: 'compression_started', thread_key: 'root' } },
  }, 'session-1');
  assert.equal(state.isCompressing.value, true);

  dispatcher.handleEnvelope({
    type: 'state_sync',
    session_id: 'session-1',
    payload: {
      category: 'compression',
      detail: { type: 'compression_summary', content: '摘要正文', thread_key: 'root', conversation_scope: 'root' },
    },
  }, 'session-1');
  assert.equal(state.isCompressing.value, false);
  assert.equal(messages.value.length, 0);
});

// 回归：/compact 的 started 帧点亮后若终端 compression 帧丢失，
// command_result（每次必发）兜底清除呼吸点并移除"正在压缩…"瞬态横线。
test('terminal command_result clears a stuck compressing indicator', () => {
  setActivePinia(createPinia());
  const { dispatcher, messages, state } = createDispatcherFixture();

  dispatcher.handleEnvelope({
    type: 'state_sync',
    session_id: 'session-1',
    payload: { category: 'compression', detail: { type: 'compression_started', forced: true, thread_key: 'root' } },
  }, 'session-1');
  assert.equal(state.isCompressing.value, true);
  assert.equal(messages.value.filter(item => item.metadata?.msg_type === 'context_compression_pending').length, 1);

  dispatcher.handleEnvelope({
    type: 'state_sync',
    session_id: 'session-1',
    payload: { category: 'command_result', detail: { command: 'compact', success: true, content: '压缩完成' } },
  }, 'session-1');
  assert.equal(state.isCompressing.value, false);
  assert.equal(messages.value.filter(item => item.metadata?.msg_type === 'context_compression_pending').length, 0);
});

test('runtime 快照无 compact 租约且无活动 run 时清瞬态横线与呼吸点（后端崩溃自愈）', () => {
  setActivePinia(createPinia());
  const { dispatcher, messages, state } = createDispatcherFixture();
  messages.value = [
    { role: 'user', id: 'cmd-1', seq: 1, content: '/compact', metadata: {} },
    {
      role: 'system',
      content: '正在压缩…',
      content_parts: [{ type: 'text', text: '正在压缩…' }],
      metadata: { msg_type: 'context_compression_pending' },
    },
  ];
  state.isCompressing.value = true;

  // 快照仍持有 compact 租约：压缩进行中，保留横线与呼吸点。
  dispatcher.handleEnvelope({
    type: 'session.runtime',
    session_id: 'session-1',
    payload: { state: 'maintenance', load_strategy: 'watch_maintenance', maintenance: { kind: 'compact', expires_at: '2999-01-01T00:00:00Z' }, pending_interactions: [] },
  }, 'session-1');
  assert.equal(messages.value.some(m => m.metadata?.msg_type === 'context_compression_pending'), true);
  assert.equal(state.isCompressing.value, true);

  // 活动 run（run 内自动压缩）：无 maintenance 也不清——呼吸点归 run 生命周期管。
  state.activeRun.active = true;
  dispatcher.handleEnvelope({
    type: 'session.runtime',
    session_id: 'session-1',
    payload: { state: 'running', load_strategy: 'attach_run', maintenance: null, pending_interactions: [] },
  }, 'session-1');
  assert.equal(messages.value.some(m => m.metadata?.msg_type === 'context_compression_pending'), true);
  assert.equal(state.isCompressing.value, true);
  state.activeRun.active = false;

  // 租约结束（释放/60s 过期，崩溃场景唯一清除线）：清横线与呼吸点。
  dispatcher.handleEnvelope({
    type: 'session.runtime',
    session_id: 'session-1',
    payload: { state: 'idle', load_strategy: 'history', maintenance: null, pending_interactions: [] },
  }, 'session-1');
  assert.equal(messages.value.some(m => m.metadata?.msg_type === 'context_compression_pending'), false);
  assert.equal(state.isCompressing.value, false);
});

// 回归：子 run 的 assistant 落库帧不得落入根列表。
// 根因：旧守卫按"run_id ≠ 活跃 run"过滤，活跃 run 为空（后台委派/收尾后）时
// 子答案气泡会整块泄漏进根视图。修复：凡带子身份（顶层 participant_id 或
// payload.lineage.parent_call_id）的 assistant message_saved 一律不进根列表。
test('子 run assistant message_saved 不进根列表（无活跃 run 也不泄漏）', () => {
  setActivePinia(createPinia());
  const { dispatcher, messages } = createDispatcherFixture();

  const childSaved = {
    type: 'state_sync',
    session_id: 'session-1',
    run_id: 'child-run-9',
    participant_id: 'child-9',
    payload: {
      category: 'message_saved',
      lineage: { parent_call_id: 'root-call' },
      ref: {
        message_id: 'child-run-9:final',
        seq: 5,
        role: 'assistant',
        content_parts: [{ type: 'text', text: '子智能体最终答案' }],
      },
    },
  };
  dispatcher.handleEnvelope(childSaved, 'session-1');
  // 旧形状（无顶层 participant_id，仅 payload.lineage）同样拦截。
  dispatcher.handleEnvelope({
    ...childSaved,
    participant_id: undefined,
    run_id: 'child-run-10',
    payload: { ...childSaved.payload, ref: { ...childSaved.payload.ref, message_id: 'child-run-10:final' } },
  }, 'session-1');

  assert.equal(messages.value.length, 0, '子 run 的 assistant 落库帧不得在根列表建泡');
});

test('根 run 的 assistant message_saved 仍走根列表合并（守卫不影响 root）', () => {
  setActivePinia(createPinia());
  const { dispatcher, messages } = createDispatcherFixture();

  dispatcher.handleEnvelope({
    type: 'state_sync',
    session_id: 'session-1',
    run_id: 'run-root-1',
    payload: {
      category: 'message_saved',
      ref: {
        message_id: 'run-root-1:final',
        seq: 5,
        role: 'assistant',
        content_parts: [{ type: 'text', text: '主智能体最终答案' }],
      },
    },
  }, 'session-1');

  const bubbles = messages.value.filter(item => item.role === 'assistant');
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0].id, 'run-root-1:final');
});
