import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionEventReducer } from './sessionEventReducer.js';

const reference = value => ({ value });

function buildReducer() {
  const messages = reference([]);
  const activeRun = { assistantMsgIndex: 0, phase: 'processing', runningToolCalls: {}, runningModelCalls: {} };
  const calls = { chunks: [], cached: 0 };
  const contextUsage = reference({ used: 0, max: 0 });
  const deps = {
    isMasterEvent: () => true,
    isRootEvent: () => true,
    clearLlmRetryState: () => {},
    setLlmRetryState: () => {},
    findRunningExecutionAgentByAgentId: () => null,
    applyEnvelopeToMessage: () => {},
    cacheMessages: () => { calls.cached += 1; },
    scrollToBottom: () => {},
  };
  const runtime = {
    markModelRequestStarted: () => {},
    markModelAttemptStarted: () => {},
    markModelAttemptFailed: () => {},
    markModelAttemptCompleted: () => {},
    markLlmFirstToken: () => {},
    markOutputChunk: (_event, content) => calls.chunks.push(content),
    markRecentSessionUpdated: () => {},
    markToolStarted: () => {},
    markToolFinished: () => {},
  };
  const reducer = createSessionEventReducer({
    deps,
    runtime,
    activeRun,
    messages,
    isCompressing: reference(false),
    contextUsage,
    llmRetryState: reference(null),
    handleApprovalRequired: () => {},
    handleUserInputRequired: () => {},
  });
  return { reducer, messages, activeRun, calls, contextUsage };
}

test('SessionEventReducer routes child stream output through execution projection', () => {
  const { messages, calls } = buildReducer();
  const currentMessage = { content: 'root output', metadata: {}, status: [], finished: false };
  messages.value.push(currentMessage);

  // Child stream_output carries lineage and must stay in the execution projection.
  const childReducer = createSessionEventReducer({
    deps: {
      isMasterEvent: event => !event.payload?.lineage?.parent_call_id,
      isRootEvent: event => !event.payload?.lineage?.parent_call_id,
      clearLlmRetryState: () => {},
      setLlmRetryState: () => {},
      findRunningExecutionAgentByAgentId: () => null,
      applyEnvelopeToMessage: () => { calls.chunks.push('projected'); },
      cacheMessages: () => {},
      scrollToBottom: () => {},
    },
    runtime: {
      markModelRequestStarted: () => {},
      markModelAttemptStarted: () => {},
      markModelAttemptFailed: () => {},
      markModelAttemptCompleted: () => {},
      markLlmFirstToken: () => {},
      markOutputChunk: () => {},
      markRecentSessionUpdated: () => {},
      markToolStarted: () => {},
      markToolFinished: () => {},
    },
    activeRun: { assistantMsgIndex: 0, phase: 'processing', runningToolCalls: {}, runningModelCalls: {} },
    messages,
    isCompressing: reference(false),
    contextUsage: reference({ used: 0, max: 0 }),
    llmRetryState: reference(null),
    handleApprovalRequired: () => {},
    handleUserInputRequired: () => {},
  });

  childReducer({
    type: 'stream_output',
    call_id: 'child-call',
    payload: {
      phase: 'delta',
      content: 'child output',
      lineage: { parent_call_id: 'root-call' },
    },
  }, currentMessage, 'session-1');

  assert.equal(currentMessage.content, 'root output');
  assert.deepEqual(calls.chunks, ['projected']);
});

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
});

test('SessionEventReducer incrementally inserts file parts and reconciles the final snapshot', () => {
  const { reducer, messages } = buildReducer();
  const currentMessage = { content: '', metadata: {}, status: [], finished: false };
  messages.value.push(currentMessage);

  reducer({
    type: 'stream_output',
    payload: { phase: 'delta', content: 'Map: ', part_index: 0 },
  }, currentMessage, 'session-1');
  reducer({
    type: 'stream_output',
    payload: {
      phase: 'part_added',
      part_index: 1,
      part: { type: 'file_ref', file_path: 'results/map.png', presentation: 'inline' },
    },
  }, currentMessage, 'session-1');
  reducer({
    type: 'stream_output',
    payload: {
      phase: 'final',
      content: 'Map: \n\nFile: map.png (results/map.png)\n\n',
      content_parts: [
        { type: 'text', text: 'Map: ' },
        { type: 'file_ref', file_path: 'results/map.png', presentation: 'inline' },
      ],
    },
  }, currentMessage, 'session-1');

  const rich = currentMessage.metadata.extensions.find(extension => extension.kind === 'rich_content');
  assert.deepEqual(rich.data.parts[1], {
    type: 'file_ref',
    file_path: 'results/map.png',
    presentation: 'inline',
  });
  assert.equal(currentMessage.finished, true);
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

test('SessionEventReducer ignores estimates and only displays provider usage', () => {
  const { reducer, contextUsage } = buildReducer();
  const currentMessage = { content: '', metadata: {}, status: [], finished: false };

  reducer({
    type: 'state_sync',
    session_id: 'session-1',
    run_id: 'run-1',
    payload: { category: 'context_usage', detail: {
      used_tokens: 2000, budget_tokens: 8000, token_source: 'estimate',
    } },
  }, currentMessage, 'session-1');
  assert.deepEqual(contextUsage.value, { used: 0, max: 0 });

  reducer({
    type: 'state_sync',
    session_id: 'session-1',
    run_id: 'run-1',
    payload: { category: 'context_usage', detail: {
      used_tokens: 1000, budget_tokens: 8000, token_source: 'provider',
    } },
  }, currentMessage, 'session-1');
  assert.deepEqual(contextUsage.value, {
    used: 1000,
    max: 8000,
    source: 'provider',
    providerUsed: 1000,
  });

  reducer({
    type: 'state_sync',
    session_id: 'session-1',
    run_id: 'run-2',
    payload: { category: 'context_usage', detail: {
      used_tokens: 2020, budget_tokens: 8000, token_source: 'estimate',
    } },
  }, currentMessage, 'session-1');
  assert.deepEqual(contextUsage.value, {
    used: 1000,
    max: 8000,
    source: 'provider',
    providerUsed: 1000,
  });
});
