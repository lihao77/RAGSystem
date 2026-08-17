import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionEventReducer } from './sessionEventReducer.js';

const reference = value => ({ value });

function buildReducer({ depOverrides = {} } = {}) {
  const messages = reference([]);
  const activeRun = { assistantMsgIndex: 0, phase: 'processing', runningToolCalls: {}, runningModelCalls: {}, isReplaying: false };
  const calls = { chunks: [], cached: 0 };
  const contextUsage = reference({ used: 0, max: 0 });
  const runtimeState = { replaying: false };
  const deps = {
    isMasterEvent: () => true,
    // 测试约定：agent_id === 'child-agent' 的事件视为子 agent 事件。
    isRootEvent: event => event.agent_id !== 'child-agent',
    clearLlmRetryState: () => {},
    setLlmRetryState: () => {},
    findRunningExecutionAgentByAgentId: () => null,
    applyEnvelopeToMessage: () => {},
    cacheMessages: () => { calls.cached += 1; },
    scrollToBottom: () => {},
    ...depOverrides,
  };
  const runtime = {
    markModelRequestStarted: () => {},
    markModelAttemptStarted: () => {},
    markModelAttemptFailed: () => {},
    markModelAttemptCompleted: () => {},
    markLlmFirstToken: () => {},
    markOutputChunk: (_event, content) => calls.chunks.push(content),
    markRecentSessionUpdated: () => {},
    markRootAgentStarted: () => {},
    markToolStarted: () => {},
    markToolFinished: () => {},
    isDurableReplayActive: () => runtimeState.replaying,
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
  return { reducer, messages, activeRun, calls, contextUsage, runtimeState };
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
  const currentMessage = { content: '', content_parts: [], metadata: {}, status: [], finished: false };
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

  assert.deepEqual(currentMessage.content_parts[1], {
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

test('SessionEventReducer aggregates cache hit and context composition details', () => {
  const { reducer, contextUsage } = buildReducer();
  const currentMessage = { content: '', metadata: {}, status: [], finished: false };

  reducer({
    type: 'state_sync',
    session_id: 'session-1',
    run_id: 'run-1',
    payload: { category: 'context_usage', detail: {
      used_tokens: 5000,
      budget_tokens: 8000,
      token_source: 'provider',
      system_prompt_tokens: 3000,
      history_tokens: 2000,
      tool_schema_tokens: 1200,
      mcp_tool_tokens: 400,
      skill_tool_tokens: 300,
      cached_input_tokens: 4100,
      input_tokens: 5000,
    } },
  }, currentMessage, 'session-1');

  assert.deepEqual(contextUsage.value, {
    used: 5000,
    max: 8000,
    source: 'provider',
    providerUsed: 5000,
    systemPromptTokens: 3000,
    historyTokens: 2000,
    toolSchemaTokens: 1200,
    mcpToolTokens: 400,
    skillToolTokens: 300,
    cachedInputTokens: 4100,
    inputTokens: 5000,
  });
});

test('SessionEventReducer drops cache/composition details when the event lacks them', () => {
  const { reducer, contextUsage } = buildReducer();
  const currentMessage = { content: '', metadata: {}, status: [], finished: false };

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
});

test('SessionEventReducer accumulates cache deltas across runs into session totals', () => {
  const { reducer, contextUsage } = buildReducer();
  const currentMessage = { content: '', metadata: {}, status: [], finished: false };
  const contextUsageEvent = (runId, cached, input) => ({
    type: 'state_sync',
    session_id: 'session-1',
    run_id: runId,
    payload: { category: 'context_usage', detail: {
      used_tokens: input, budget_tokens: 8000, token_source: 'provider',
      cached_input_tokens: cached, input_tokens: input,
    } },
  });

  // run-1：第一轮命中 1000/5000，第二轮 1400/5400 → session 累计 = 1400/5400。
  reducer(contextUsageEvent('run-1', 1000, 5000), currentMessage, 'session-1');
  reducer(contextUsageEvent('run-1', 1400, 5400), currentMessage, 'session-1');
  assert.equal(contextUsage.value.cachedInputTokens, 1400);
  assert.equal(contextUsage.value.inputTokens, 5400);

  // run-1 结束、run-2 开始（agent_started 重置基线）→ 新 run 命中 300/4000 → session 累计 = 1700/9400。
  reducer({
    type: 'agent_started',
    session_id: 'session-1',
    run_id: 'run-2',
    agent_id: 'agent-1',
    payload: {},
  }, currentMessage, 'session-1');
  reducer(contextUsageEvent('run-2', 300, 4000), currentMessage, 'session-1');
  assert.equal(contextUsage.value.cachedInputTokens, 1700);
  assert.equal(contextUsage.value.inputTokens, 9400);
});

test('SessionEventReducer accumulates cache creation totals across runs', () => {
  const { reducer, contextUsage } = buildReducer();
  const currentMessage = { content: '', metadata: {}, status: [], finished: false };
  // 首轮只有 cache 写入没有读取（cached=0, creation>0），run-2 才发生读取。
  const contextUsageEvent = (runId, cached, creation, input) => ({
    type: 'state_sync',
    session_id: 'session-1',
    run_id: runId,
    payload: { category: 'context_usage', detail: {
      used_tokens: input, budget_tokens: 8000, token_source: 'provider',
      cached_input_tokens: cached, cache_creation_input_tokens: creation, input_tokens: input,
    } },
  });

  reducer(contextUsageEvent('run-1', 0, 5000, 5000), currentMessage, 'session-1');
  assert.deepEqual(
    {
      cached: contextUsage.value.cachedInputTokens,
      creation: contextUsage.value.cacheCreationInputTokens,
      input: contextUsage.value.inputTokens,
    },
    { cached: 0, creation: 5000, input: 5000 },
  );

  reducer({
    type: 'agent_started',
    session_id: 'session-1',
    run_id: 'run-2',
    agent_id: 'agent-1',
    payload: {},
  }, currentMessage, 'session-1');
  reducer(contextUsageEvent('run-2', 3000, 0, 4000), currentMessage, 'session-1');
  assert.deepEqual(
    {
      cached: contextUsage.value.cachedInputTokens,
      creation: contextUsage.value.cacheCreationInputTokens,
      input: contextUsage.value.inputTokens,
    },
    { cached: 3000, creation: 5000, input: 9000 },
  );
});

// 两种回放模式（durable_outbox / active_run_snapshot）都经 session.reconnect 括号标记，
// 回放期间只推进基线、不做会话累计——快照播种值已含进行中 run 的已完成轮次。
function assertReplaySkipsAccumulation(setReplaying) {
  const { reducer, contextUsage, activeRun, runtimeState } = buildReducer();
  const currentMessage = { content: '', metadata: {}, status: [], finished: false };
  const contextUsageEvent = (runId, cached, input) => ({
    type: 'state_sync',
    session_id: 'session-1',
    run_id: runId,
    payload: { category: 'context_usage', detail: {
      used_tokens: input, budget_tokens: 8000, token_source: 'provider',
      cached_input_tokens: cached, input_tokens: input,
    } },
  });

  // 进会话时快照已载入 persisted 累计（含进行中 run-1 已完成的轮次）。
  contextUsage.value = {
    used: 5400, max: 8000, source: 'provider', providerUsed: 5400,
    cachedInputTokens: 1400, inputTokens: 5400,
  };
  setReplaying({ activeRun, runtimeState }, true);
  // 回放 run-1 的 agent_started 与已完成的 context_usage：不得再累加。
  reducer({
    type: 'agent_started',
    session_id: 'session-1',
    run_id: 'run-1',
    agent_id: 'agent-1',
    payload: {},
  }, currentMessage, 'session-1');
  reducer(contextUsageEvent('run-1', 1400, 5400), currentMessage, 'session-1');
  assert.equal(contextUsage.value.cachedInputTokens, 1400);
  assert.equal(contextUsage.value.inputTokens, 5400);

  // 回放结束后实时轮次正常 diff（基线已在回放期间推进到 1400/5400，只加新增部分）。
  setReplaying({ activeRun, runtimeState }, false);
  reducer(contextUsageEvent('run-1', 1600, 5800), currentMessage, 'session-1');
  assert.equal(contextUsage.value.cachedInputTokens, 1600);
  assert.equal(contextUsage.value.inputTokens, 5800);
}

test('SessionEventReducer skips session accumulation during durable_outbox replay', () => {
  assertReplaySkipsAccumulation(({ runtimeState }, on) => { runtimeState.replaying = on; });
});

test('SessionEventReducer skips session accumulation during active_run_snapshot replay', () => {
  assertReplaySkipsAccumulation(({ activeRun }, on) => { activeRun.isReplaying = on; });
});

test('SessionEventReducer folds child run cache deltas into session totals without touching root display', () => {
  const childAgent = {};
  const { reducer, contextUsage } = buildReducer({
    depOverrides: { findRunningExecutionAgentByAgentId: () => childAgent },
  });
  const currentMessage = { content: '', metadata: {}, status: [], finished: false, executionTree: {} };
  const contextUsageEvent = (runId, cached, input, agentId) => ({
    type: 'state_sync',
    session_id: 'session-1',
    run_id: runId,
    ...(agentId ? { agent_id: agentId } : {}),
    payload: { category: 'context_usage', detail: {
      used_tokens: input, budget_tokens: 8000, token_source: 'provider',
      cached_input_tokens: cached, input_tokens: input,
    } },
  });

  // root run 先建立基线 1000/5000（used=5000 来自 root 自己的上下文）。
  reducer(contextUsageEvent('run-1', 1000, 5000), currentMessage, 'session-1');
  // child run（独立 run_id → 独立基线）命中 3000/4000：会话累计折入，root 展示态不动。
  reducer(contextUsageEvent('run-child', 3000, 4000, 'child-agent'), currentMessage, 'session-1');

  assert.equal(contextUsage.value.cachedInputTokens, 4000);
  assert.equal(contextUsage.value.inputTokens, 9000);
  assert.equal(contextUsage.value.used, 5000);
  assert.equal(contextUsage.value.max, 8000);
  // child 的 agent.ctx 只携带本 run 自身的累计。
  assert.deepEqual(childAgent.ctx, {
    used: 4000,
    max: 8000,
    source: 'provider',
    providerUsed: 4000,
    cachedInputTokens: 3000,
    inputTokens: 4000,
  });

  // child 第二轮继续 diff（3000→3300），会话累计同步增加。
  reducer(contextUsageEvent('run-child', 3300, 4400, 'child-agent'), currentMessage, 'session-1');
  assert.equal(contextUsage.value.cachedInputTokens, 4300);
  assert.equal(contextUsage.value.inputTokens, 9400);
});
