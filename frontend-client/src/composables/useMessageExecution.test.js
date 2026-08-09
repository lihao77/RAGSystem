import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

import { useMessageExecution } from './useMessageExecution.js';

test('participant run anchor loads history and receives live execution events', async () => {
  const handlers = new Set();
  const calls = [];
  const chatSdkClient = {
    on(name, handler) {
      if (name === 'event') handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async getParticipantRunSteps(sessionId, participantId, runId, options) {
      calls.push({ sessionId, participantId, runId, options });
      return {
        data: {
          participant_id: participantId,
          run_id: 'child-run',
          items: [{
            type: 'agent_started',
            session_id: sessionId,
            run_id: 'child-run',
            call_id: 'child-call',
            agent_id: 'worker',
            payload: {
              phase: 'start',
              child_agent_id: participantId,
              task: 'inspect code',
            },
          }],
        },
      };
    },
  };
  const execution = useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient,
  });
  const anchor = execution.getParticipantRunExecutionMessage({
    participant_id: 'child-1',
    last_run_id: 'child-run',
    last_run_status: 'running',
  });

  await execution.ensureExecutionStepsLoaded(anchor);

  assert.deepEqual(calls, [{
    sessionId: 'session-1',
    participantId: 'child-1',
    runId: 'child-run',
    options: { limit: 500, offset: 0 },
  }]);
  assert.equal(anchor.executionTree.root.participantId, 'child-1');
  assert.equal(anchor.executionTree.root.status, 'running');

  for (const handler of handlers) {
    handler({
      type: 'tool_call',
      session_id: 'session-1',
      run_id: 'child-run',
      call_id: 'tool-1',
      agent_id: 'worker',
      payload: {
        phase: 'start',
        tool: 'shell_command',
        input: { command: 'rg TODO' },
        lineage: { parent_call_id: 'child-call' },
      },
    });
  }

  assert.equal(anchor.executionTree.root.rounds[0].toolCalls[0].callId, 'tool-1');
});
