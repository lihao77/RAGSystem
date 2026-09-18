// 回归：run_ended(interrupted/failed) 不得覆盖已落地的后端终态文案。
// 根因：中断时后端按序投递 stream_output(final)/message_saved（含中断原因、
// Goal 暂停行与 salvage 思考）→ run_ended；前端 run_ended 分支曾无条件用本地
// 合成文案整体覆盖 content/content_parts，导致实时视图丢失 Goal 暂停行，
// 刷新后按持久化消息渲染才可见。修复：终态帧已到达（气泡定格 finished 或已
// 绑定消息 id）时保留后端全文，仅帧丢失时回退本地兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

import { useSessionRunStore } from '../stores/session-run.js';
import { createSessionEnvelopeDispatcher } from './sessionEnvelopeDispatcher.js';

const TERMINAL_TEXT = '本次运行已中断，未生成最终答案。原因：用户主动停止运行\n目标「完成报告」已暂停，已有进度已保留。';
const TERMINAL_PARTS = [
  { type: 'thinking', text: '半截思考', complete: false },
  { type: 'text', text: TERMINAL_TEXT },
];

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
    terminalStatusFromEvent: event => event.payload?.status || 'completed',
    markModelAttemptCompleted: () => {},
    markRecentSessionUpdated: () => {},
    finalizeActiveRun: () => {},
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
      isMasterEvent: () => true,
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

const runStarted = runId => ({
  type: 'run_started',
  session_id: 'session-1',
  run_id: runId,
  payload: { request_id: `req-${runId}`, task: '推进目标' },
});

const terminalSaved = runId => ({
  type: 'state_sync',
  session_id: 'session-1',
  run_id: runId,
  payload: {
    category: 'message_saved',
    ref: {
      message_id: `msg-${runId}`,
      seq: 3,
      role: 'assistant',
      run_id: runId,
      content_parts: TERMINAL_PARTS,
    },
  },
});

const runEnded = (runId, status, reason) => ({
  type: 'run_ended',
  session_id: 'session-1',
  run_id: runId,
  payload: { status, ...(reason ? { reason } : {}) },
});

test('run_ended 中断不覆盖 message_saved 已落地的终态文案（含 Goal 暂停行）', () => {
  setActivePinia(createPinia());
  const { dispatcher, messages } = createDispatcherFixture();

  dispatcher.handleEnvelope(runStarted('run-1'), 'session-1');
  dispatcher.handleEnvelope(terminalSaved('run-1'), 'session-1');
  dispatcher.handleEnvelope(runEnded('run-1', 'interrupted', 'session_stopped'), 'session-1');

  const bubble = messages.value.find(item => item.role === 'assistant' && item.id === 'msg-run-1');
  assert.ok(bubble, '终态消息应绑定到运行气泡');
  assert.equal(bubble.finished, true);
  assert.equal(bubble.metadata.terminal_status, 'interrupted');
  assert.equal(bubble.metadata.interrupted, true);
  const textPart = bubble.content_parts.find(part => part.type === 'text');
  assert.match(textPart.text, /目标「完成报告」已暂停，已有进度已保留/);
  // salvage 思考是终态消息的一等 part，本地合成会丢掉它——保留后端 parts 即保留思考。
  assert.ok(bubble.content_parts.some(part => part.type === 'thinking'), 'thinking part 应保留');
});

test('终态帧丢失时 run_ended 仍回退本地合成兜底', () => {
  setActivePinia(createPinia());
  const { dispatcher, messages } = createDispatcherFixture();

  dispatcher.handleEnvelope(runStarted('run-2'), 'session-1');
  dispatcher.handleEnvelope(runEnded('run-2', 'interrupted', 'session_stopped'), 'session-1');

  const bubble = messages.value.find(item => item.role === 'assistant' && item.run_id === 'run-2');
  assert.ok(bubble, '运行气泡应存在');
  assert.equal(
    bubble.content,
    '本次运行已中断，未生成最终答案。原因：用户主动停止运行',
    '帧丢失时应保留本地兜底文案',
  );
  assert.deepEqual(bubble.content_parts, [{ type: 'text', text: bubble.content }]);
  assert.equal(bubble.metadata.interrupted, true);
});

test('run_ended 失败同样保留 message_saved 已落地的终态文案', () => {
  setActivePinia(createPinia());
  const { dispatcher, messages } = createDispatcherFixture();

  dispatcher.handleEnvelope(runStarted('run-4'), 'session-1');
  dispatcher.handleEnvelope({
    ...terminalSaved('run-4'),
    payload: {
      category: 'message_saved',
      ref: {
        message_id: 'msg-run-4',
        seq: 5,
        role: 'assistant',
        run_id: 'run-4',
        content_parts: [{ type: 'text', text: '本次运行执行失败：模型通道不可用' }],
      },
    },
  }, 'session-1');
  dispatcher.handleEnvelope(runEnded('run-4', 'failed', '模型通道不可用'), 'session-1');

  const bubble = messages.value.find(item => item.role === 'assistant' && item.id === 'msg-run-4');
  assert.ok(bubble, '终态消息应绑定到运行气泡');
  assert.equal(bubble.run_failed, true);
  assert.equal(bubble.metadata.terminal_status, 'failed');
  assert.equal(
    bubble.content_parts.find(part => part.type === 'text')?.text,
    '本次运行执行失败：模型通道不可用',
  );
});

test('stream_output(final) 先到而 message_saved 丢失时，run_ended 保留 final 全文', () => {
  setActivePinia(createPinia());
  const { dispatcher, messages } = createDispatcherFixture();

  dispatcher.handleEnvelope(runStarted('run-5'), 'session-1');
  dispatcher.handleEnvelope({
    type: 'stream_output',
    session_id: 'session-1',
    run_id: 'run-5',
    call_id: 'call-root',
    payload: {
      phase: 'final',
      content: TERMINAL_TEXT,
      content_parts: [{ type: 'text', text: TERMINAL_TEXT }],
    },
  }, 'session-1');
  dispatcher.handleEnvelope(runEnded('run-5', 'interrupted', 'session_stopped'), 'session-1');

  // 门控的 finished 半边：final 帧已把气泡定格 finished=true（id 未绑定），
  // run_ended 不得用本地合成覆盖 final 写入的全文。
  const bubble = messages.value.find(item => item.role === 'assistant' && item.run_id === 'run-5');
  assert.ok(bubble, '运行气泡应存在');
  assert.equal(bubble.id, undefined, 'message_saved 丢失时 id 不应被绑定');
  assert.equal(bubble.content, TERMINAL_TEXT, 'final 全文（含 Goal 暂停行）应保留');
  assert.equal(bubble.metadata.terminal_status, 'interrupted');
  assert.equal(bubble.metadata.interrupted, true);
});

test('历史加载后的 run_ended 重放不覆盖持久化终态文案（刷新+回放场景）', () => {
  setActivePinia(createPinia());
  const { dispatcher, messages } = createDispatcherFixture();

  messages.value.push({
    role: 'assistant',
    id: 'msg-run-3',
    seq: 8,
    content: TERMINAL_TEXT,
    content_parts: TERMINAL_PARTS,
    finished: true,
    run_id: 'run-3',
    metadata: { run_id: 'run-3' },
  });
  dispatcher.handleEnvelope(runEnded('run-3', 'interrupted', 'session_stopped'), 'session-1');

  const bubble = messages.value.find(item => item.id === 'msg-run-3');
  assert.equal(bubble.content, TERMINAL_TEXT, '历史终态文案不得被本地合成覆盖');
  assert.equal(bubble.metadata.terminal_status, 'interrupted');
});
