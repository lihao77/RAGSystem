import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, reactive, ref } from 'vue';

import { useMessageExecution } from './useMessageExecution.js';

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
    executionTree: { root: null, steps: [] },
  };
  const execution = useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages: ref({ 'child-1': [message] }),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient: {
      on() { return () => {}; },
      async getMessageRunSteps(sessionId, messageId, options) {
        calls.push({ sessionId, messageId, options });
        return { data: { items: [childStarted()], has_more: false } };
      },
    },
  });

  await execution.ensureExecutionStepsLoaded(message);

  assert.deepEqual(calls, [{
    sessionId: 'session-1',
    messageId: 'child-message',
    options: { limit: 500, offset: 0, participantId: 'child-1' },
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
    executionTree: { root: null, steps: [] },
  };
  const execution = useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('root'),
    participantMessages: ref({ root: [message] }),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient: {
      on() { return () => {}; },
      async getMessageRunSteps(sessionId, messageId, options) {
        calls.push({ sessionId, messageId, options });
        return { data: { items: [], has_more: false } };
      },
    },
  });

  await execution.ensureExecutionStepsLoaded(message);

  assert.deepEqual(calls, [{
    sessionId: 'session-1',
    messageId: 'child-run:terminal_result',
    options: { limit: 500, offset: 0 },
  }]);
});

test('child envelopes wait for the durable message and project onto that exact object', async () => {
  const handlers = new Set();
  const participantMessages = ref({ 'child-1': [] });
  const reloads = [];
  let releaseReload;
  useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages,
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    syncParticipantMessage() {
      assert.fail('execution envelopes must not create a virtual message');
    },
    reloadParticipantMessages(sessionId, participantId) {
      reloads.push({ sessionId, participantId });
      return new Promise(resolve => { releaseReload = resolve; });
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
    handler(childToolCall());
  }
  assert.deepEqual(reloads, [{ sessionId: 'session-1', participantId: 'child-1' }]);
  assert.deepEqual(participantMessages.value['child-1'], []);

  const durableMessage = reactive({
    role: 'user',
    id: 'child-message',
    run_id: 'child-run',
    child_agent_id: 'child-1',
    has_execution: true,
    executionTree: { root: null, steps: [] },
  });
  participantMessages.value = { 'child-1': [durableMessage] };
  await nextTick();
  releaseReload();
  await nextTick();

  assert.equal(participantMessages.value['child-1'][0], durableMessage);
  assert.equal(durableMessage.executionTree.root.rounds[0].toolCalls[0].callId, 'tool-1');
});

test('child projection removes only the external parent of its Run root', async () => {
  const message = {
    role: 'user',
    id: 'child-message',
    run_id: 'child-run',
    child_agent_id: 'child-1',
    has_execution: true,
    executionTree: { root: null, steps: [] },
  };
  const pages = [
    [childStarted({
      payload: {
        phase: 'start',
        child_agent_id: 'child-1',
        lineage: { parent_call_id: 'root-call' },
      },
    })],
    [childToolCall()],
  ];
  let page = 0;
  const execution = useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages: ref({ 'child-1': [message] }),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient: {
      on() { return () => {}; },
      async getMessageRunSteps() {
        const items = pages[page++];
        return { data: { items, has_more: page < pages.length } };
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
    executionTree: { root: null, steps: [] },
  };
  const execution = useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    participantMessages: ref({ 'child-1': [message] }),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient: {
      async getMessageRunSteps() {
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
        ], has_more: false } };
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
