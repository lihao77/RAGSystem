import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionTaskState } from './sessionTaskState.js';

function createHarness(overrides = {}) {
  const currentSessionId = { value: 'session-1' };
  const sessionTaskInfo = { value: null };
  const sessionExecutionObservability = { value: null };
  const taskState = createSessionTaskState({
    currentSessionId,
    sessionTaskInfo,
    sessionExecutionObservability,
    fetchTaskStatus: async () => ({ data: {} }),
    warn: () => {},
    ...overrides,
  });
  return { currentSessionId, sessionTaskInfo, sessionExecutionObservability, taskState };
}

test('SessionTaskState merges observability while preserving known fields', () => {
  const harness = createHarness();
  harness.sessionExecutionObservability.value = {
    task_id: 'task-1',
    session_id: 'session-1',
    run_id: 'run-1',
    execution_kind: 'agent_stream',
    request_id: 'request-1',
  };

  harness.taskState.mergeExecutionObservability({ run_id: 'run-2', request_id: null });

  assert.deepEqual(harness.sessionExecutionObservability.value, {
    task_id: 'task-1',
    session_id: 'session-1',
    run_id: 'run-2',
    execution_kind: 'agent_stream',
    request_id: 'request-1',
  });
});

test('SessionTaskState ignores a refresh response after the active session changes', async () => {
  let resolveRequest;
  const request = new Promise(resolve => { resolveRequest = resolve; });
  const harness = createHarness({ fetchTaskStatus: () => request });

  const refresh = harness.taskState.refreshSessionExecutionState('session-1');
  harness.currentSessionId.value = 'session-2';
  resolveRequest({
    data: {
      task_info: { status: 'running' },
      observability: { session_id: 'session-1', run_id: 'run-1' },
    },
  });
  await refresh;

  assert.equal(harness.sessionTaskInfo.value, null);
  assert.equal(harness.sessionExecutionObservability.value, null);
});

test('SessionTaskState initializes an optimistic running execution', () => {
  const harness = createHarness();
  harness.sessionTaskInfo.value = { retained: true, status: 'idle' };

  harness.taskState.beginOptimisticExecutionState('session-1');

  assert.equal(harness.sessionTaskInfo.value.retained, true);
  assert.equal(harness.sessionTaskInfo.value.status, 'running');
  assert.equal(harness.sessionTaskInfo.value.thread_alive, true);
  assert.equal(harness.sessionTaskInfo.value.execution_kind, 'agent_stream');
  assert.deepEqual(harness.sessionExecutionObservability.value, {
    task_id: null,
    session_id: 'session-1',
    run_id: null,
    execution_kind: 'agent_stream',
    request_id: null,
  });
});
