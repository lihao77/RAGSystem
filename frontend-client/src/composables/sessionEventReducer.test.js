import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionEventReducer } from './sessionEventReducer.js';

const reference = value => ({ value });

function buildReducer() {
  const messages = reference([]);
  const activeRun = { assistantMsgIndex: 0, phase: 'llm_waiting_first_token', waiting: null };
  const calls = { chunks: [], cached: 0, situation: 0 };
  const deps = {
    isMasterEvent: () => true,
    isRootEvent: () => true,
    clearLlmRetryState: () => {},
    setLlmRetryState: () => {},
    findRunningExecutionAgentByAgentId: () => null,
    applyEnvelopeToMessage: () => {},
    cacheMessages: () => { calls.cached += 1; },
    checkSituationScreenTrigger: () => { calls.situation += 1; },
    scrollToBottom: () => {},
  };
  const runtime = {
    markLlmFirstToken: () => {},
    markOutputChunk: (_event, content) => calls.chunks.push(content),
    markRecentSessionUpdated: () => {},
    markWaitingStart: () => {},
    markWaitingFinished: () => {},
  };
  const reducer = createSessionEventReducer({
    deps,
    runtime,
    activeRun,
    messages,
    isCompressing: reference(false),
    contextUsage: reference({ used: 0, max: 0 }),
    llmRetryState: reference(null),
    sessionTaskInfo: reference(null),
    handleApprovalRequired: () => {},
    handleUserInputRequired: () => {},
  });
  return { reducer, messages, activeRun, calls };
}

test('SessionEventReducer deterministically applies stream delta and final compensation', () => {
  const { reducer, messages, calls } = buildReducer();
  const currentMessage = { content: '', metadata: {}, status: [], finished: false };
  messages.value.push(currentMessage);

  reducer({ type: 'stream_output', payload: { phase: 'delta', content: 'hel' } }, currentMessage, 'session-1');
  reducer({ type: 'stream_output', payload: { phase: 'final', content: 'hello' } }, currentMessage, 'session-1');

  assert.equal(currentMessage.content, 'hello');
  assert.equal(currentMessage.finished, true);
  assert.deepEqual(calls.chunks, ['hel']);
  assert.equal(calls.cached, 1);
  assert.equal(calls.situation, 1);
});

test('SessionEventReducer only inserts visible root compression summaries', () => {
  const { reducer, messages, activeRun } = buildReducer();
  const currentMessage = { content: '', metadata: {}, status: [], finished: false };
  messages.value.push(currentMessage);

  reducer({
    type: 'state_sync',
    payload: { category: 'compression', detail: { content: 'root summary', thread_key: 'root' } },
  }, currentMessage, 'session-1');
  reducer({
    type: 'state_sync',
    payload: { category: 'compression', detail: { content: 'child summary', conversation_scope: 'child' } },
  }, currentMessage, 'session-1');

  assert.equal(messages.value.length, 2);
  assert.equal(messages.value[0].content, 'root summary');
  assert.equal(activeRun.assistantMsgIndex, 1);
});
