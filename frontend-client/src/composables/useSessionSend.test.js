import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

import { useSessionSend } from './useSessionSend.js';

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

function jsonResponse(payload, ok = true) {
  return {
    ok,
    json: async () => payload,
  };
}

function installBrowserGlobals(t) {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });
}

function createDeps(overrides = {}) {
  const calls = {
    fetch: [],
    wsSend: [],
    materializeAttachmentsForSend: [],
    clearComposerAttachments: 0,
    stickToBottom: 0,
    cacheMessages: [],
    updateRecentSession: [],
    scheduleCommandFallback: [],
    beginOptimisticExecutionState: [],
    showToast: [],
  };

  const ws = {
    readyState: 1,
    send: (raw) => { calls.wsSend.push(JSON.parse(raw)); },
  };

  const deps = {
    currentSessionId: ref('session-1'),
    inputMessage: ref(''),
    pendingAttachments: ref([]),
    messages: ref([]),
    isLoading: ref(false),
    sessionTaskInfo: ref(null),
    contextUsage: ref({ used: 0, max: 0 }),
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
    ensureSession: async () => deps.currentSessionId.value,
    getWS: () => ws,
    getCurrentSelectedLlm: () => 'openai/gpt-test',
    materializeAttachmentsForSend: async (attachments) => {
      calls.materializeAttachmentsForSend.push(attachments);
      return attachments;
    },
    clearComposerAttachments: () => { calls.clearComposerAttachments += 1; },
    stickToBottom: () => { calls.stickToBottom += 1; },
    cacheMessages: (...args) => { calls.cacheMessages.push(args); },
    updateRecentSession: (...args) => { calls.updateRecentSession.push(args); },
    scheduleCommandFallback: (...args) => { calls.scheduleCommandFallback.push(args); },
    beginOptimisticExecutionState: (...args) => { calls.beginOptimisticExecutionState.push(args); },
    mergeExecutionObservability: () => {},
    resetEditingState: () => {},
    clearEditingAttachments: () => {},
    showToast: (...args) => { calls.showToast.push(args); },
    ...overrides,
  };

  return { deps, calls };
}

test('运行中发送会作为 session followup 插入当前 assistant 前并复用当前 run', async (t) => {
  installBrowserGlobals(t);
  globalThis.fetch = async () => {
    return jsonResponse({ data: { has_running_task: true, task_info: { status: 'running' } } });
  };

  const assistant = createAssistantMessage({ content: '正在处理', finished: false });
  const { deps, calls } = createDeps();
  deps.messages.value = [
    { role: 'user', content: '原始任务', metadata: {}, attachments: [] },
    assistant,
  ];
  Object.assign(deps.activeRun, {
    active: true,
    assistantMsgIndex: 1,
    runId: 'run-1',
    phase: 'llm_streaming',
  });
  deps.isLoading.value = true;

  const sender = useSessionSend(deps);
  await sender.handleSend({ content: '补充：优先处理 A', attachments: [] });

  assert.equal(deps.messages.value.length, 3);
  assert.equal(deps.messages.value[1].role, 'user');
  assert.equal(deps.messages.value[1].content, '补充：优先处理 A');
  assert.equal(deps.messages.value[1].metadata.execution_kind, 'session_followup');
  assert.equal(deps.messages.value[1].metadata.source, 'running_session');
  assert.equal(deps.messages.value[1].metadata.run_id, 'run-1');
  assert.equal(typeof deps.messages.value[1].metadata.request_id, 'string');
  assert.equal(deps.messages.value[2].role, 'assistant');
  assert.equal(deps.messages.value[2].content, '正在处理');
  assert.equal(deps.activeRun.assistantMsgIndex, 2);
  assert.equal(deps.activeRun.runId, 'run-1');
  assert.equal(deps.isLoading.value, true);
  assert.deepEqual(calls.materializeAttachmentsForSend, []);
  assert.deepEqual(calls.scheduleCommandFallback, []);
  assert.equal(calls.beginOptimisticExecutionState.length, 0);
  assert.equal(calls.wsSend.length, 1);
  assert.equal(calls.wsSend[0].type, 'send');
  assert.equal(calls.wsSend[0].task, '补充：优先处理 A');
  assert.equal(calls.wsSend[0].request_id, deps.messages.value[1].metadata.request_id);
});

test('普通发送仍会创建 assistant 占位并启动新的 active run', async (t) => {
  installBrowserGlobals(t);
  globalThis.fetch = async () => jsonResponse({ data: { has_running_task: false, task_info: null } });

  const { deps, calls } = createDeps();
  const sender = useSessionSend(deps);
  await sender.handleSend({ content: '执行新任务', attachments: [] });

  assert.equal(deps.messages.value.length, 2);
  assert.equal(deps.messages.value[0].role, 'user');
  assert.equal(deps.messages.value[0].metadata.execution_kind, 'agent_stream');
  assert.equal(typeof deps.messages.value[0].metadata.request_id, 'string');
  assert.equal(deps.messages.value[1].role, 'assistant');
  assert.equal(deps.activeRun.active, true);
  assert.equal(deps.activeRun.assistantMsgIndex, 1);
  assert.equal(deps.isLoading.value, true);
  assert.equal(calls.materializeAttachmentsForSend.length, 1);
  assert.equal(calls.beginOptimisticExecutionState.length, 1);
  assert.equal(calls.scheduleCommandFallback.length, 1);
  assert.equal(calls.wsSend[0].request_id, deps.messages.value[0].metadata.request_id);
});
