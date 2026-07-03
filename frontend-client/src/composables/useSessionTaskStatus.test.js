import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

import { useSessionTaskStatus } from './useSessionTaskStatus.js';
import { useSessionRunStore, createActiveRunState } from '../stores/session-run.js';
import { httpClient } from '../api/http.js';

function createDeps(overrides = {}) {
  setActivePinia(createPinia());
  const sessionRunStore = useSessionRunStore();
  const { currentSessionId, messages, isLoading, sessionTaskInfo } = storeToRefs(sessionRunStore);
  currentSessionId.value = 'session-1';
  const activeRun = sessionRunStore.activeRun;
  const calls = {
    deleteMessageCache: [],
    loadSessionMessages: [],
    scheduleResumeRecovery: [],
  };
  const deps = {
    currentSessionId,
    messages,
    isLoading,
    sessionTaskInfo,
    shouldRefreshFn: () => false,
    shouldRunWatchdogFn: () => false,
    getActiveRun: () => activeRun,
    invalidateActiveStream: () => {},
    deleteMessageCache: (...args) => { calls.deleteMessageCache.push(args); },
    loadSessionMessages: async (...args) => { calls.loadSessionMessages.push(args); },
    createAssistantMessage: () => ({ role: 'assistant', content: '', finished: false }),
    scheduleCommandFallback: () => {},
    scheduleResumeRecovery: (...args) => { calls.scheduleResumeRecovery.push(args); },
    clearLlmRetryState: () => {},
    ...overrides,
  };
  return { deps, activeRun, calls };
}

function withMock(setup, run) {
  const mock = new MockAdapter(httpClient);
  setup(mock);
  return Promise.resolve()
    .then(run)
    .finally(() => { mock.restore(); });
}

test('checkSessionTaskStatus clears stale active run when selected session is idle', async () => {
  await withMock((mock) => {
    mock.onGet(/\/task-status$/).reply(200, {
      data: {
        has_running_task: false,
        has_active_system_command: false,
        task_info: { status: 'completed', run_id: 'run-ended' },
      },
    });
  }, async () => {
    const { deps, activeRun } = createDeps();
    Object.assign(activeRun, {
      active: true,
      assistantMsgIndex: 2,
      runId: 'run-old',
      phase: 'tool_running',
      runStartedAt: 123,
      lastSeenSeq: 9,
      outputCharCount: 42,
    });
    deps.isLoading.value = true;
    const status = useSessionTaskStatus(deps);

    await status.checkSessionTaskStatus('session-1');

    assert.equal(activeRun.active, false);
    assert.equal(activeRun.assistantMsgIndex, -1);
    assert.equal(activeRun.runId, null);
    assert.equal(activeRun.phase, 'idle');
    assert.equal(activeRun.runStartedAt, null);
    assert.equal(activeRun.lastSeenSeq, 0);
    assert.equal(activeRun.outputCharCount, 0);
    assert.equal(deps.isLoading.value, false);
    assert.equal(deps.sessionTaskInfo.value.status, 'completed');
  });
});

test('checkSessionTaskStatus ignores stale responses from a previous session', async () => {
  await withMock((mock) => {
    mock.onGet(/\/task-status$/).reply(200, {
      data: {
        has_running_task: true,
        has_active_system_command: false,
        task_info: { status: 'running', run_id: 'run-old' },
      },
    });
  }, async () => {
    const { deps, activeRun, calls } = createDeps({
      shouldRunWatchdogFn: () => true,
    });
    deps.currentSessionId.value = 'session-2';
    const status = useSessionTaskStatus(deps);

    await status.checkSessionTaskStatus('session-1');

    assert.equal(deps.sessionTaskInfo.value, null);
    assert.deepEqual(activeRun, createActiveRunState());
    assert.deepEqual(calls.scheduleResumeRecovery, []);
  });
});
