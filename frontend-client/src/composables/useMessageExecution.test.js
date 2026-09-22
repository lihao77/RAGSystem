import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, reactive, ref } from 'vue';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

import { useSessionRunStore } from '../stores/session-run.js';
import { normalizeAssistantExecutionState, useMessageExecution } from './useMessageExecution.js';

test('run identity does not create execution availability during history/cache normalization', () => {
  for (const identity of [
    { run_id: 'run-1' },
    { metadata: { run_id: 'run-1' } },
    { metadata: { consumed_by_run_id: 'run-1' } },
  ]) {
    for (const role of ['user', 'assistant']) {
      const message = normalizeAssistantExecutionState({ role, has_execution: false, ...identity });
      assert.equal(message.run_id, 'run-1');
      assert.equal(message.has_execution, false);
      assert.equal(normalizeAssistantExecutionState(message).has_execution, false);
    }
  }
  assert.equal(normalizeAssistantExecutionState({ role: 'user', has_execution: true }).has_execution, true);
  assert.equal(normalizeAssistantExecutionState({
    role: 'user', has_execution: false, executionTree: { root: { callId: 'run-1' } },
  }).has_execution, true);
});

const childStarted = (overrides = {}) => ({
  type: 'agent_started',
  session_id: 'session-1',
  run_id: 'child-run',
  call_id: 'child-call',
  agent_id: 'worker',
  payload: {
    phase: 'start',
    child_agent_id: 'child-1',
    task: 'inspect code',
  },
  ...overrides,
});

const childToolCall = () => ({
  type: 'tool_call',
  session_id: 'session-1',
  run_id: 'child-run',
  call_id: 'tool-1',
  agent_id: 'worker',
  payload: {
    phase: 'start',
    child_agent_id: 'child-1',
    tool: 'shell_command',
    input: { command: 'rg TODO' },
    lineage: { parent_call_id: 'child-call' },
  },
});

test('historical child execution loads by its real message boundary', async () => {
  const calls = [];
  const message = {
    role: 'user',
    id: 'child-message',
    run_id: 'child-run',
    child_agent_id: 'child-1',
    has_execution: true,
    executionTree: { root: null },
  };
  const execution = useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages: ref({ 'child-1': [message] }),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient: {
      on() { return () => {}; },
      async getMessageExecution(sessionId, messageId, options) {
        calls.push({ sessionId, messageId, options });
        return { data: { items: [childStarted()] } };
      },
    },
  });

  await execution.ensureExecutionStepsLoaded(message);

  assert.deepEqual(calls, [{
    sessionId: 'session-1',
    messageId: 'child-message',
    options: { participantId: 'child-1' },
  }]);
  assert.equal(message.executionTree.root.participantId, 'child-1');
  assert.equal(message.executionStepsLoaded, true);
});

test('root agent result uses its target thread instead of source child metadata', async () => {
  const calls = [];
  const message = {
    role: 'user',
    id: 'child-run:terminal_result',
    run_id: 'root-run',
    thread_key: 'root',
    child_agent_id: null,
    metadata: {
      child_agent_id: 'child-1',
      source_child_agent_id: 'child-1',
      target_thread_key: 'root',
      consumed_by_run_id: 'root-run',
    },
    has_execution: true,
    executionTree: { root: null },
  };
  const execution = useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('root'),
    participantMessages: ref({ root: [message] }),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient: {
      on() { return () => {}; },
      async getMessageExecution(sessionId, messageId, options) {
        calls.push({ sessionId, messageId, options });
        return { data: { items: [] } };
      },
    },
  });

  await execution.ensureExecutionStepsLoaded(message);

  assert.deepEqual(calls, [{
    sessionId: 'session-1',
    messageId: 'child-run:terminal_result',
    options: {},
  }]);
});

test('child envelopes project onto the durable boundary while the run carrier stays separate', async () => {
  const handlers = new Set();
  const participantMessages = ref({ 'child-1': [] });
  // 模拟 store 的去重合并口径（id 或 assistant 同 run_id）：载体只建一条。
  const syncParticipantMessage = (participantId, message) => {
    const list = participantMessages.value[participantId] || [];
    const idMatch = message?.id ? list.findIndex(item => item?.id === message.id) : -1;
    const runMatch = message?.role === 'assistant'
      ? list.findIndex(item => item?.role === 'assistant'
        && (item?.run_id || item?.metadata?.run_id) === (message?.run_id || message?.metadata?.run_id))
      : -1;
    const index = idMatch >= 0 ? idMatch : runMatch;
    const next = [...list];
    if (index >= 0) Object.assign(next[index], message);
    else next.push(message);
    participantMessages.value = { ...participantMessages.value, [participantId]: next };
  };
  useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages,
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    syncParticipantMessage,
    chatSdkClient: {
      on(name, handler) {
        if (name === 'event') handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  });

  for (const handler of handlers) {
    handler(childStarted());
    handler(childToolCall());
  }

  // agent_started 建消息槽载体（与 root run_started 建泡同构）：一条空 assistant，未完成。
  const afterStart = participantMessages.value['child-1'];
  assert.equal(afterStart.length, 1);
  assert.equal(afterStart[0].role, 'assistant');
  assert.equal(afterStart[0].run_id, 'child-run');
  assert.equal(afterStart[0].finished, false);

  const durableMessage = reactive({
    role: 'user',
    id: 'child-message',
    run_id: 'child-run',
    child_agent_id: 'child-1',
    has_execution: true,
    executionTree: { root: null },
  });
  participantMessages.value = { 'child-1': [durableMessage, afterStart[0]] };
  await nextTick();

  // 执行树照旧投影到持久 boundary 本体；载体不承载过程。
  assert.equal(durableMessage.executionTree.root.rounds[0].toolCalls[0].callId, 'tool-1');
  assert.equal(participantMessages.value['child-1'][0], durableMessage);
  const carriers = participantMessages.value['child-1'].filter(item => item.role === 'assistant');
  assert.equal(carriers.length, 1);
  assert.equal(carriers[0].content, '');
});

test('child final streams into the run carrier and message_saved only merges identity', () => {
  const handlers = new Set();
  const participantMessages = ref({ 'child-1': [] });
  const syncParticipantMessage = (participantId, message) => {
    const list = participantMessages.value[participantId] || [];
    const idMatch = message?.id ? list.findIndex(item => item?.id === message.id) : -1;
    const runMatch = message?.role === 'assistant'
      ? list.findIndex(item => item?.role === 'assistant'
        && (item?.run_id || item?.metadata?.run_id) === (message?.run_id || message?.metadata?.run_id))
      : -1;
    const index = idMatch >= 0 ? idMatch : runMatch;
    const next = [...list];
    if (index >= 0) Object.assign(next[index], message);
    else next.push(message);
    participantMessages.value = { ...participantMessages.value, [participantId]: next };
  };
  useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages,
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    syncParticipantMessage,
    chatSdkClient: {
      on(name, handler) {
        if (name === 'event') handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  });

  for (const handler of handlers) {
    handler(childStarted());
    handler({
      type: 'stream_output',
      session_id: 'session-1',
      run_id: 'child-run',
      participant_id: 'child-1',
      payload: { phase: 'final', content: '子智能体最终答案', content_parts: [{ type: 'text', text: '子智能体最终答案' }] },
    });
    handler({
      type: 'state_sync',
      session_id: 'session-1',
      run_id: 'child-run',
      participant_id: 'child-1',
      payload: {
        category: 'message_saved',
        lineage: { parent_call_id: 'root-call' },
        ref: {
          message_id: 'child-run:final',
          seq: 9,
          role: 'assistant',
          content_parts: [{ type: 'text', text: '子智能体最终答案' }],
        },
      },
    });
  }

  // final 全文直达载体（与根路径同构）；message_saved 经 run_id 去重只合并 id/seq——
  // 全程只有一条 assistant 气泡，最终答案不依赖 message_saved 送达。
  const bubbles = participantMessages.value['child-1'].filter(item => item.role === 'assistant');
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0].id, 'child-run:final');
  assert.equal(bubbles[0].seq, 9);
  assert.equal(bubbles[0].content, '子智能体最终答案');
  assert.equal(bubbles[0].finished, true);
});

test('child run_ended finalizes an unfinished carrier', () => {
  const handlers = new Set();
  const participantMessages = ref({ 'child-1': [] });
  useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages,
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    syncParticipantMessage(participantId, message) {
      participantMessages.value = {
        ...participantMessages.value,
        [participantId]: [...(participantMessages.value[participantId] || []), message],
      };
    },
    chatSdkClient: {
      on(name, handler) {
        if (name === 'event') handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  });

  for (const handler of handlers) {
    handler(childStarted());
    handler({
      type: 'run_ended',
      session_id: 'session-1',
      run_id: 'child-run',
      participant_id: 'child-1',
      payload: { status: 'interrupted', reason: 'session_stopped' },
    });
  }

  const [carrier] = participantMessages.value['child-1'];
  assert.equal(carrier.role, 'assistant');
  assert.equal(carrier.finished, true);
  assert.equal(carrier.stopped, true);
  assert.equal(carrier.metadata.terminal_status, 'interrupted');
});

test('child run_ended stamps failure flags even after final already finished the carrier', () => {
  // 失败/中断 run 的终局顺序是 final（带终局文本，定格 finished）→ message_saved →
  // run_ended：旗标补齐不得因 finished 早退，否则失败状态永远缺失。
  const handlers = new Set();
  const participantMessages = ref({ 'child-1': [] });
  useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages,
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    syncParticipantMessage(participantId, message) {
      const list = participantMessages.value[participantId] || [];
      const runMatch = message?.role === 'assistant'
        ? list.findIndex(item => item?.role === 'assistant'
          && (item?.run_id || item?.metadata?.run_id) === (message?.run_id || message?.metadata?.run_id))
        : -1;
      const next = [...list];
      if (runMatch >= 0) Object.assign(next[runMatch], message);
      else next.push(message);
      participantMessages.value = { ...participantMessages.value, [participantId]: next };
    },
    chatSdkClient: {
      on(name, handler) {
        if (name === 'event') handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  });

  for (const handler of handlers) {
    handler(childStarted());
    handler({
      type: 'stream_output',
      session_id: 'session-1',
      run_id: 'child-run',
      participant_id: 'child-1',
      payload: { phase: 'final', content: '本次运行执行失败：工具报错', content_parts: [{ type: 'text', text: '本次运行执行失败：工具报错' }] },
    });
    handler({
      type: 'state_sync',
      session_id: 'session-1',
      run_id: 'child-run',
      participant_id: 'child-1',
      payload: {
        category: 'message_saved',
        ref: {
          message_id: 'child-run:terminal',
          seq: 8,
          role: 'assistant',
          content_parts: [{ type: 'text', text: '本次运行执行失败：工具报错' }],
        },
      },
    });
    handler({
      type: 'run_ended',
      session_id: 'session-1',
      run_id: 'child-run',
      participant_id: 'child-1',
      payload: { status: 'failed', reason: 'tool_error' },
    });
  }

  const [carrier] = participantMessages.value['child-1'].filter(item => item.role === 'assistant');
  assert.equal(carrier.finished, true);
  assert.equal(carrier.run_failed, true);
  assert.equal(carrier.metadata.terminal_status, 'failed');
  assert.equal(carrier.content, '本次运行执行失败：工具报错');
});

test('child execution events keep a durable user boundary finished like the root path', () => {
  const handlers = new Set();
  const boundary = reactive({
    role: 'user',
    id: 'child-message',
    run_id: 'child-run',
    child_agent_id: 'child-1',
    finished: true,
    has_execution: true,
    executionTree: { root: null },
  });
  useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages: ref({ 'child-1': [boundary] }),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient: {
      on(name, handler) {
        if (name === 'event') handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  });

  for (const handler of handlers) {
    handler(childStarted({ boundary_message_id: 'child-message' }));
    handler({ ...childToolCall(), boundary_message_id: 'child-message' });
  }

  assert.equal(boundary.finished, true);
  assert.equal(boundary.executionTree.root.rounds[0].toolCalls[0].status, 'running');
});

test('child projection removes only the external parent of its Run root', async () => {
  const message = {
    role: 'user',
    id: 'child-message',
    run_id: 'child-run',
    child_agent_id: 'child-1',
    has_execution: true,
    executionTree: { root: null },
  };
  const envelopes = [
    childStarted({
      payload: {
        phase: 'start',
        child_agent_id: 'child-1',
        lineage: { parent_call_id: 'root-call' },
      },
    }),
    childToolCall(),
  ];
  const execution = useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages: ref({ 'child-1': [message] }),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient: {
      on() { return () => {}; },
      async getMessageExecution() {
        return { data: { items: envelopes } };
      },
    },
  });

  await execution.ensureExecutionStepsLoaded(message);

  assert.equal(message.executionTree.root.agentId, 'worker');
  assert.equal(message.executionTree.root.rounds[0].toolCalls[0].callId, 'tool-1');
});

test('child message boundary beginning at model_request does not create an external parent node', async () => {
  const message = {
    role: 'user',
    id: 'stop-message',
    run_id: 'child-run',
    child_agent_id: 'child-1',
    has_execution: true,
    executionTree: { root: null },
  };
  const execution = useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages: ref({ 'child-1': [message] }),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient: {
      async getMessageExecution() {
        return { data: { items: [
          {
            type: 'model_request',
            run_id: 'child-run',
            call_id: 'child-call',
            agent_id: 'worker',
            payload: { phase: 'start', round: 3, lineage: { parent_call_id: 'root-call' } },
          },
          {
            type: 'stream_output',
            run_id: 'child-run',
            call_id: 'child-call',
            agent_id: 'worker',
            payload: { phase: 'delta', content: '已收到停止指令', lineage: { parent_call_id: 'root-call' } },
          },
        ] } };
      },
    },
  });

  await execution.ensureExecutionStepsLoaded(message);

  assert.equal(message.executionTree.root.callId, 'child-call');
  assert.equal(message.executionTree.root.parentCallId, undefined);
  assert.equal(message.executionTree.root.children.length, 0);
});

test('agent_message creates only its real conversation message', () => {
  const handlers = new Set();
  const synced = [];
  useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages: ref({ 'child-1': [] }),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    syncParticipantMessage(participantId, message) { synced.push({ participantId, message }); },
    chatSdkClient: {
      on(name, handler) {
        if (name === 'event') handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  });

  for (const handler of handlers) handler({
    type: 'agent_message',
    session_id: 'session-1',
    run_id: 'source-run',
    message_id: 'mailbox-1',
    payload: {
      kind: 'request',
      message_id: 'mailbox-1',
      seq: 17,
      source_agent_name: 'Coordinator',
      target_child_agent_id: 'child-1',
      target_thread_key: 'child:child-1',
      content: '停止工具调用',
      content_parts: [{ type: 'text', text: '停止工具调用' }],
    },
  });

  assert.equal(synced.length, 1);
  assert.equal(synced[0].participantId, 'child-1');
  assert.equal(synced[0].message.role, 'user');
  assert.equal(synced[0].message.id, 'mailbox-1');
  assert.equal(synced[0].message.seq, 17);
  assert.equal(synced[0].message.run_id, null);
  assert.equal(synced[0].message.has_execution, false);
});

test('child final message_saved without a live carrier still creates the full bubble', () => {
  const handlers = new Set();
  const synced = [];
  useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages: ref({ 'child-1': [] }),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    syncParticipantMessage(participantId, message) { synced.push({ participantId, message }); },
    chatSdkClient: {
      on(name, handler) {
        if (name === 'event') handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  });

  for (const handler of handlers) {
    // 未经历 agent_started/final（如中途加入会话）：message_saved 整块建泡的保底路径不变。
    // 终局 message_saved 现自带顶层 participant_id（后端盖章），无需从别的信封推断归属。
    handler({
      type: 'state_sync',
      session_id: 'session-1',
      run_id: 'child-run',
      participant_id: 'child-1',
      payload: {
        category: 'message_saved',
        lineage: { parent_call_id: 'root-call' },
        ref: {
          id: 'child-terminal',
          seq: 3,
          role: 'assistant',
          content_parts: [{ type: 'text', text: '子智能体最终答案' }],
        },
      },
    });
  }

  assert.equal(synced.length, 1);
  assert.equal(synced[0].participantId, 'child-1');
  assert.equal(synced[0].message.role, 'assistant');
  assert.equal(synced[0].message.id, 'child-terminal');
  assert.equal(synced[0].message.content, '子智能体最终答案');
  assert.equal(synced[0].message.finished, true);
});

test('root-targeted agent messages upsert a realtime root conversation message', () => {
  const handlers = new Set();
  const synced = [];
  useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('root'),
    participantMessages: ref({ root: [] }),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    syncParticipantMessage(participantId, message) { synced.push({ participantId, message }); },
    chatSdkClient: {
      on(name, handler) {
        if (name === 'event') handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  });

  for (const handler of handlers) handler({
    type: 'agent_message',
    session_id: 'session-1',
    run_id: 'child-run',
    payload: {
      kind: 'result',
      message_id: 'mailbox-root',
      source_agent_name: 'Worker',
      target_child_agent_id: null,
      target_thread_key: 'root',
      content: '子任务完成',
    },
  });

  assert.equal(synced.length, 1);
  assert.equal(synced[0].participantId, 'root');
  assert.equal(synced[0].message.id, 'mailbox-root');
  assert.equal(synced[0].message.run_id, null);
  assert.equal(synced[0].message.metadata.mailbox_kind, 'result');
});

test('streaming deltas coalesce into one rAF publish per frame', () => {
  const message = reactive({
    role: 'user',
    id: 'child-message',
    run_id: 'child-run',
    child_agent_id: 'child-1',
    has_execution: true,
    executionTree: { root: null },
  });
  const execution = useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages: ref({ 'child-1': [message] }),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient: { on() { return () => {}; } },
  });

  const reasoningDelta = content => ({
    type: 'stream_output',
    session_id: 'session-1',
    run_id: 'child-run',
    call_id: 'child-call',
    payload: { phase: 'reasoning_delta', content, round: 0 },
  });

  const rafCallbacks = [];
  let rafCount = 0;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = cb => { rafCount += 1; rafCallbacks.push(cb); return rafCount; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    execution.applyEnvelopeToMessage(message, childStarted());
    // 高频 delta 只入队：一帧内多次到达只请求一次 rAF，树在冲刷前保持上一发布态。
    execution.applyEnvelopeToMessage(message, reasoningDelta('先'));
    execution.applyEnvelopeToMessage(message, reasoningDelta('想'));
    execution.applyEnvelopeToMessage(message, reasoningDelta('一步'));
    assert.equal(rafCount, 1);
    assert.equal(message.executionTree.root.rounds.length, 0);

    rafCallbacks.shift()();
    assert.equal(message.executionTree.root.rounds[0].reasoning, '先想一步');

    // 冲刷后再次流式会重新排帧，而不是复用已消费的回调。
    execution.applyEnvelopeToMessage(message, reasoningDelta('。'));
    assert.equal(rafCount, 2);
    rafCallbacks.shift()();
    assert.equal(message.executionTree.root.rounds[0].reasoning, '先想一步。');
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
  }
});

test('non-delta events flush queued deltas first to preserve tree order', () => {
  const message = reactive({
    role: 'user',
    id: 'child-message',
    run_id: 'child-run',
    child_agent_id: 'child-1',
    has_execution: true,
    executionTree: { root: null },
  });
  const execution = useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages: ref({ 'child-1': [message] }),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient: { on() { return () => {}; } },
  });

  const rafCallbacks = [];
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = cb => { rafCallbacks.push(cb); return rafCallbacks.length; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const textDelta = content => ({
      type: 'stream_output',
      session_id: 'session-1',
      run_id: 'child-run',
      call_id: 'child-call',
      payload: { phase: 'delta', content, round: 0 },
    });
    execution.applyEnvelopeToMessage(message, childStarted());
    execution.applyEnvelopeToMessage(message, textDelta('正在'));
    execution.applyEnvelopeToMessage(message, textDelta('检查'));
    // tool_call 立即落地：必须先冲刷同帧排队的 delta，工具才能挂在文本之后。
    execution.applyEnvelopeToMessage(message, childToolCall());

    assert.equal(message.executionTree.root.rounds[0].text, '正在检查');
    assert.equal(message.executionTree.root.rounds[0].toolCalls[0].callId, 'tool-1');
    // 新 delta 只入队不落地；被消费过的帧回调已失效，需重新排帧。
    execution.applyEnvelopeToMessage(message, textDelta('！'));
    assert.equal(message.executionTree.root.rounds.length, 1);
    rafCallbacks.shift()();
    // 工具之后的正文增量按 ReAct 语义开启新轮，且顺序在工具之后。
    assert.equal(message.executionTree.root.rounds[1].text, '！');
    assert.equal(message.executionTree.root.rounds[0].toolCalls[0].callId, 'tool-1');
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
  }
});

// 回归：create 委派的子 run 启动时没有 agent_message（合成指令不是智能体消息），
// 输入边界改由 message_saved 的 user ref 播报。此前该边界在 wire 上完全缺席，
// 前端只能把整个 run 的执行帧堆在待投队列里——实时视图只剩最终答案（要等切换重载补齐）。
// 本测试按后端真实帧序回放：边界 → run 锚点 → 执行帧 → 终局；帧形由
// backend-core/test/async-event-persister.test.ts 钉住（persister 侧契约）。
test('create 委派的子 run：输入边界随 message_saved 到达，执行帧挂上同一条边界', async () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  const { participantMessages } = storeToRefs(store);
  store.currentSessionId = 'session-1';
  const handlers = new Set();
  useMessageExecution({
    currentSessionId: ref('session-1'),
    chatSdkClient: {
      sessionId: 'session-1',
      on(name, handler) {
        if (name === 'event') handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    participantMessages,
    syncParticipantMessage: store.upsertParticipantMessage,
  });

  const frames = [
    {
      type: 'state_sync',
      session_id: 'session-1',
      run_id: 'child-run',
      participant_id: 'child-1',
      boundary_message_id: 'msg-task-1',
      payload: {
        category: 'message_saved',
        ref: {
          message_id: 'msg-task-1',
          role: 'user',
          request_id: 'req-child',
          content_parts: [{ type: 'text', text: '统计近一周日均水位。' }],
          metadata: {
            run_id: 'child-run',
            child_agent_id: 'child-1',
            source: 'agent_call',
            execution_kind: 'call_agent',
          },
        },
      },
    },
    childStarted({ boundary_message_id: 'msg-task-1' }),
    childToolCall({ boundary_message_id: 'msg-task-1' }),
    {
      type: 'tool_result',
      session_id: 'session-1',
      run_id: 'child-run',
      call_id: 'tool-1',
      agent_id: 'worker',
      boundary_message_id: 'msg-task-1',
      payload: { phase: 'end', tool: 'shell_command', ok: true, observation: 'TC04 超警戒线两天', lineage: { parent_call_id: 'child-call' } },
    },
    {
      type: 'stream_output',
      session_id: 'session-1',
      run_id: 'child-run',
      participant_id: 'child-1',
      boundary_message_id: 'msg-task-1',
      payload: { phase: 'final', content: '近一周日均水位 12.4m。', content_parts: [{ type: 'text', text: '近一周日均水位 12.4m。' }] },
    },
    {
      type: 'state_sync',
      session_id: 'session-1',
      run_id: 'child-run',
      participant_id: 'child-1',
      boundary_message_id: 'msg-task-1',
      payload: {
        category: 'message_saved',
        ref: {
          message_id: 'msg-final-1',
          seq: 412,
          role: 'assistant',
          content_parts: [{ type: 'text', text: '近一周日均水位 12.4m。' }],
        },
      },
    },
  ];
  for (const handler of handlers) for (const frame of frames) handler(frame);
  await nextTick();

  const list = participantMessages.value['child-1'];
  assert.deepEqual(list.map(item => item.role), ['user', 'assistant'], '子线程 = 输入边界 + 最终答案');

  const [boundary, answer] = list;
  assert.equal(boundary.id, 'msg-task-1');
  assert.equal(boundary.run_id, 'child-run');
  assert.equal(boundary.content, '统计近一周日均水位。');
  assert.equal(boundary.finished, true);
  assert.equal(boundary.executionTree?.root?.rounds?.[0]?.toolCalls?.[0]?.toolName, 'shell_command', '执行过程必须挂在输入边界上');
  assert.equal(boundary.has_execution, true);
  assert.equal(answer.content, '近一周日均水位 12.4m。');
  assert.equal(answer.finished, true);
  // 主对话列不因这条边界多出任何东西。
  assert.deepEqual(store.messages, []);
});
