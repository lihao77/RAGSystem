import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

import { useSessionRunStore } from '../stores/session-run.js';
import { useSessionParticipants } from './useSessionParticipants.js';

test('participant lifecycle events update the local projection without another request', async () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  store.currentSessionId = 'session-1';
  const handlers = new Set();
  let requests = 0;
  const scope = effectScope();
  const state = scope.run(() => useSessionParticipants({
    chatSdkClient: {
      sessionId: 'session-1',
      on(type, handler) {
        if (type === 'event') handlers.add(handler);
        return () => handlers.delete(handler);
      },
      async listSessionParticipants() {
        requests += 1;
        return { data: { items: [{
          participant_id: 'root',
          parent_participant_id: null,
          scope: 'root',
          agent_name: 'assistant',
          display_name: 'Assistant',
          thread_key: 'root',
          lifecycle_status: 'active',
          last_run_id: null,
          last_run_status: null,
        }] } };
      },
    },
    showToast() {},
  }));

  await state.loadSessionParticipants('session-1');
  for (const handler of handlers) handler({
    type: 'agent_started',
    session_id: 'session-1',
    run_id: 'child-run',
    agent_id: 'worker',
    payload: { child_agent_id: 'child-1', display_name: 'Worker' },
  });
  for (const handler of handlers) handler({
    type: 'agent_ended',
    session_id: 'session-1',
    run_id: 'child-run',
    agent_id: 'worker',
    payload: { status: 'succeeded', display_name: 'Worker' },
  });

  assert.equal(requests, 1);
  assert.deepEqual(state.participants.value.map(item => ({
    id: item.participant_id,
    runId: item.last_run_id,
    status: item.last_run_status,
  })), [
    { id: 'root', runId: null, status: null },
    { id: 'child-1', runId: 'child-run', status: 'completed' },
  ]);
  scope.stop();
});
