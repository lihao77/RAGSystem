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

test('participant history reuses the live run carrier and keeps receiving events', () => {
  const handlers = new Set();
  const execution = useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient: {
      on(name, handler) {
        if (name === 'event') handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  });
  const anchor = execution.getParticipantRunExecutionMessage({
    participant_id: 'child-1',
    last_run_id: 'child-run',
    last_run_status: 'running',
  });
  const history = execution.createAssistantMessageFromHistory({
    id: 'child-run:final',
    role: 'assistant',
    content: 'result',
    child_agent_id: 'child-1',
    thread_key: 'child:child-1',
    metadata: { run_id: 'child-run' },
    has_execution: true,
  });

  assert.equal(history, anchor);
  assert.equal(anchor.id, 'child-run:final');

  for (const handler of handlers) {
    handler({
      type: 'agent_started',
      session_id: 'session-1',
      run_id: 'child-run',
      call_id: 'child-call',
      agent_id: 'worker',
      payload: { phase: 'start', child_agent_id: 'child-1', task: 'inspect code' },
    });
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

  assert.equal(history.executionTree.root.rounds[0].toolCalls[0].callId, 'tool-1');
});

test('participant Run list exposes historical and latest execution carriers', async () => {
  const runListCalls = [];
  const execution = useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient: {
      on() { return () => {}; },
      async listSessionParticipantRuns(sessionId, participantId, options) {
        runListCalls.push({ sessionId, participantId, options });
        const firstPage = options.offset === 0;
        return {
          data: {
            participant_id: 'child-1',
            items: firstPage
              ? [{ run_id: 'child-run-2', status: 'completed', task_summary: 'stop', created_at: '2026-08-09T00:00:02Z' }]
              : [{ run_id: 'child-run-1', status: 'completed', task_summary: 'ten tools', created_at: '2026-08-09T00:00:01Z' }],
            has_more: firstPage,
          },
        };
      },
    },
  });
  const participant = {
    participant_id: 'child-1',
    last_run_id: 'child-run-2',
    last_run_status: 'completed',
  };

  await execution.ensureParticipantRunsLoaded(participant);
  const messages = execution.getParticipantRunExecutionMessages(participant);

  assert.deepEqual(messages.map(message => message.run_id), ['child-run-1', 'child-run-2']);
  assert.equal(messages[0].metadata.task_summary, 'ten tools');
  assert.deepEqual(runListCalls.map(call => call.options.offset), [0, 1]);
});

test('participant projection removes only the external parent of its Run root', async () => {
  const stepOffsets = [];
  const execution = useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    chatSdkClient: {
      on() { return () => {}; },
      async getParticipantRunSteps(_sessionId, _participantId, _runId, options) {
        stepOffsets.push(options.offset);
        const firstPage = options.offset === 0;
        return {
          data: {
            participant_id: 'child-1',
            run_id: 'child-run',
            items: firstPage ? [{
              type: 'agent_started',
              session_id: 'session-1',
              run_id: 'child-run',
              call_id: 'child-call',
              agent_id: 'worker',
              payload: {
                phase: 'start',
                child_agent_id: 'child-1',
                lineage: { parent_call_id: 'root-call' },
              },
            }] : [{
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
            }],
            has_more: firstPage,
          },
        };
      },
    },
  });
  const message = execution.getParticipantRunExecutionMessage({
    participant_id: 'child-1',
    last_run_id: 'child-run',
    last_run_status: 'completed',
  });

  await execution.ensureExecutionStepsLoaded(message);

  assert.equal(message.executionTree.root.agentId, 'worker');
  assert.equal(message.executionTree.root.rounds[0].toolCalls[0].callId, 'tool-1');
  assert.deepEqual(stepOffsets, [0, 1]);
});

test('production mailbox events create the child bubble and carrier before identity-free stream output', () => {
  const handlers = new Set();
  const synced = [];
  useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('child-1'),
    activeRun: { runId: 'root-run', rootCallId: 'root-call' },
    syncParticipantMessage(participantId, message) { synced.push({ participantId, message }); },
    chatSdkClient: {
      on(name, handler) {
        if (name === 'event') handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  });

  for (const handler of handlers) {
    handler({
      type: 'agent_message',
      session_id: 'session-1',
      run_id: 'child-run',
      call_id: 'child-call',
      message_id: 'mailbox-1',
      payload: {
        kind: 'request',
        message_id: 'mailbox-1',
        source_agent_name: 'Coordinator',
        target_child_agent_id: 'child-1',
        target_thread_key: 'child:child-1',
        content: '停止工具调用',
        content_parts: [{ type: 'text', text: '停止工具调用' }],
      },
    });
    handler({
      type: 'stream_output',
      session_id: 'session-1',
      run_id: 'child-run',
      call_id: 'child-call',
      agent_id: 'worker',
      payload: { phase: 'delta', content: '正在停止', lineage: { parent_call_id: 'root-call' } },
    });
    handler({
      type: 'stream_output',
      session_id: 'session-1',
      run_id: 'child-run',
      call_id: 'child-call',
      agent_id: 'worker',
      payload: { phase: 'final', content: '已停止', content_parts: [{ type: 'text', text: '已停止' }], lineage: { parent_call_id: 'root-call' } },
    });
  }

  assert.equal(synced.length, 2);
  assert.equal(synced[0].participantId, 'child-1');
  assert.equal(synced[0].message.role, 'user');
  assert.equal(synced[0].message.id, 'mailbox-1');
  assert.equal(synced[0].message.content, '停止工具调用');
  assert.equal(synced[0].message.metadata.agent_message_source_agent_name, 'Coordinator');
  assert.equal(synced[1].message.role, 'assistant');
  assert.equal(synced[1].message.content, '已停止');
  assert.equal(synced[1].message.finished, true);
  assert.deepEqual(synced[1].message.content_parts, [{ type: 'text', text: '已停止' }]);
});

test('root-targeted agent messages upsert a realtime root conversation bubble', () => {
  const handlers = new Set();
  const synced = [];
  useMessageExecution({
    currentSessionId: ref('session-1'),
    selectedParticipantId: ref('root'),
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
    run_id: 'root-run',
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
  assert.equal(synced[0].message.run_id, 'root-run');
  assert.equal(synced[0].message.metadata.run_id, 'root-run');
  assert.equal(synced[0].message.metadata.mailbox_kind, 'result');
});
