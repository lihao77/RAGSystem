import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

import { createActiveRunState } from './useActiveRunState.js';
import { useSessionTaskStatus } from './useSessionTaskStatus.js';

function createDeps(overrides = {}) {
  const activeRun = overrides.activeRun || createActiveRunState();
  const calls = {
    deleteMessageCache: [],
    loadSessionMessages: [],
    scheduleResumeRecovery: [],
  };
  const deps = {
    currentSessionId: ref('session-1'),
    messages: ref([]),
    isLoading: ref(false),
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

function withFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

test('checkSessionTaskStatus clears stale active run when selected session is idle', async () => {
  await withFetch(async () => ({
    ok: true,
    json: async () => ({
      data: {
        has_running_task: false,
        has_active_system_command: false,
        task_info: { status: 'completed', run_id: 'run-ended' },
      },
    }),
  }), async () => {
    const activeRun = createActiveRunState();
    Object.assign(activeRun, {
      active: true,
      assistantMsgIndex: 2,
      runId: 'run-old',
      phase: 'tool_running',
      runStartedAt: 123,
      lastSeenSeq: 9,
      outputCharCount: 42,
    });
    const { deps } = createDeps({
      activeRun,
      isLoading: ref(true),
    });
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
    assert.equal(status.sessionTaskInfo.value.status, 'completed');
  });
});

test('checkSessionTaskStatus ignores stale responses from a previous session', async () => {
  await withFetch(async () => ({
    ok: true,
    json: async () => ({
      data: {
        has_running_task: true,
        has_active_system_command: false,
        task_info: { status: 'running', run_id: 'run-old' },
      },
    }),
  }), async () => {
    const { deps, activeRun, calls } = createDeps({
      currentSessionId: ref('session-2'),
      shouldRunWatchdogFn: () => true,
    });
    const status = useSessionTaskStatus(deps);

    await status.checkSessionTaskStatus('session-1');

    assert.equal(status.sessionTaskInfo.value, null);
    assert.deepEqual(activeRun, createActiveRunState());
    assert.deepEqual(calls.scheduleResumeRecovery, []);
  });
});
