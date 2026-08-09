import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createTenantId } from '@ragsystem/backend-core/identity/types.js';
import { buildTerminalAssistantMessage } from '@ragsystem/backend-core/contracts/storage/runtime-finalization.js';
import { SessionRuntimeService } from '@ragsystem/backend-core/services/runtime/session-runtime-service.js';
import { createConversationStore } from '../dist/adapters/local/sqlite/conversation-store/index.js';
import { SqliteRuntimeStorage } from '../dist/adapters/local/sqlite-runtime-storage.js';
import { computeSessionTeamRevision } from '@ragsystem/backend-core/contracts/session/session.js';

const tenantId = createTenantId('tnt_test');
const agents = { root: { agent_name: 'root' } };
const teamSnapshot = { team_name: 'test', team_revision: computeSessionTeamRevision(agents), entry_agent_name: 'root', agents };

async function createHarness(t) {
  const root = await mkdtemp(join(tmpdir(), 'ragsystem-runtime-recovery-'));
  const store = createConversationStore({ dbPath: join(root, 'runtime.db'), dataRoot: root });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const storage = new SqliteRuntimeStorage(tenantId, store);
  store.createSession({
    tenantId,
    sessionId: 'session-1',
    ownerUserId: 'usr_test',
    visibility: 'private',
    originType: 'direct',
    originId: null,
    originChannel: 'web',
    workspaceId: null,
    teamSnapshot,
    metadata: {},
  });
  store.createRun({
    runId: 'run-1',
    sessionId: 'session-1',
    entrypoint: 'agent_stream',
    status: 'running',
    taskSummary: 'task',
    requestId: 'req-1',
    agentName: 'root',
    agentCallId: 'root-call-1',
    lineageParentCallId: null,
    agentDisplayName: 'Root',
    leaseRootRunId: 'run-1',
    threadKey: 'root',
  });
  return { store, storage, runtime: new SessionRuntimeService(storage) };
}

function createInteraction(store) {
  return store.createPendingInteraction({
    interactionId: 'interaction-1',
    sessionId: 'session-1',
    runId: 'run-1',
    rootRunId: 'run-1',
    toolCallId: 'tool-1',
    batchId: 'batch-1',
    kind: 'approval',
    requestPayload: {
      interaction_payload: {
        kind: 'approval',
        phase: 'required',
        tool: 'write_file',
        message: '允许写入？',
      },
    },
  });
}

function resumeAttachRecord(claimId) {
  const event = {
    type: 'state_sync',
    session_id: 'session-1',
    run_id: 'run-1',
    payload: {
      category: 'session_updated',
      detail: { entity: 'session_runtime', reason: 'resume_executor_attached' },
    },
  };
  const eventId = `${claimId}:resume_executor_attached`;
  return {
    step: {
      sessionId: 'session-1',
      runId: 'run-1',
      stepType: 'state_sync',
      payload: { client_event: event },
    },
    outbox: {
      eventId,
      sessionId: 'session-1',
      runId: 'run-1',
      eventType: 'client.state_sync',
      aggregateType: 'run',
      aggregateId: 'run-1',
      payload: { client_event: event },
    },
  };
}

test('message participant identity comes from canonical fields, not metadata', (t) => {
  const store = createConversationStore({ dbPath: ':memory:', dataRoot: process.cwd() });
  t.after(() => store.close());
  store.createSession({
    tenantId,
    sessionId: 'identity-session',
    ownerUserId: 'usr_test',
    visibility: 'private',
    originType: 'direct',
    originId: null,
    originChannel: 'web',
    workspaceId: null,
    teamSnapshot,
    metadata: {},
  });

  const rootMessage = store.addMessage({
    sessionId: 'identity-session',
    role: 'user',
    content: 'root',
    contentParts: [{ type: 'text', text: 'root' }],
    metadata: { thread_key: 'metadata-child', child_agent_id: 'metadata-child' },
  });
  assert.equal(rootMessage.thread_key, 'root');
  assert.equal(rootMessage.child_agent_id, null);
  assert.equal(rootMessage.metadata.thread_key, 'metadata-child');

  const childMessage = store.addMessage({
    sessionId: 'identity-session',
    role: 'assistant',
    content: 'child',
    contentParts: [{ type: 'text', text: 'child' }],
    threadKey: 'child:worker',
    childAgentId: 'worker',
    metadata: { thread_key: 'wrong-thread', child_agent_id: 'wrong-child' },
  });
  assert.equal(childMessage.thread_key, 'child:worker');
  assert.equal(childMessage.child_agent_id, 'worker');
  assert.equal(childMessage.metadata.thread_key, 'wrong-thread');
});

test('停止 Session 时保留 child 终态 assistant 的 participant 身份', async (t) => {
  const { store, storage } = await createHarness(t);
  store.createRun({
    runId: 'child-run',
    sessionId: 'session-1',
    status: 'running',
    agentName: 'worker',
    agentCallId: 'child-call',
    lineageParentCallId: 'root-call-1',
    agentDisplayName: 'Worker',
    leaseRootRunId: 'run-1',
    threadKey: 'child:child-1',
    parentRunId: 'run-1',
    parentCallId: 'invoke-child',
    childAgentId: 'child-1',
  });

  await storage.operations.interruptSession({ sessionId: 'session-1' });

  const childRun = store.getRun('session-1', 'child-run');
  const finalMessage = store.getMessageById('session-1', childRun.final_message_id);
  assert.equal(finalMessage.thread_key, 'child:child-1');
  assert.equal(finalMessage.child_agent_id, 'child-1');
});

async function createResumeClaim(store, storage) {
  createInteraction(store);
  store.updatePendingInteractionStatus({
    sessionId: 'session-1',
    interactionId: 'interaction-1',
    from: ['waiting'],
    status: 'resolved',
    resolution: { kind: 'approval', approved: true, message: '' },
  });
  store.updateRunStatus('run-1', 'session-1', 'suspended', null);
  const claim = await storage.operations.claimResume({
    sessionId: 'session-1',
    interactionId: 'interaction-1',
    claimId: 'claim-1',
    leaseMs: 60_000,
  });
  assert.equal(claim.claimed, true);
  return claim;
}

test('Local 崩溃恢复会把等待交互的 running run 收敛为 suspended', async (t) => {
  const { store, storage, runtime } = await createHarness(t);
  createInteraction(store);

  const recovered = await storage.recoverOrphanedRuns();
  const snapshot = await runtime.getSnapshot('session-1');

  assert.deepEqual(recovered.suspendedRuns, [{ runId: 'run-1', parentRunId: null }]);
  assert.equal(store.getRun('session-1', 'run-1').status, 'suspended');
  assert.equal(snapshot.state, 'suspended');
  assert.equal(snapshot.pending_interactions[0].status, 'suspended');
  assert.deepEqual(snapshot.allowed_actions, ['respond_interaction', 'stop_run']);
});

test('Local 崩溃恢复释放 resuming claim，并保留 durable resolution 供 resume_run', async (t) => {
  const { store, storage, runtime } = await createHarness(t);
  createInteraction(store);
  store.updatePendingInteractionStatus({
    sessionId: 'session-1',
    interactionId: 'interaction-1',
    from: ['waiting'],
    status: 'resolved',
    resolution: { kind: 'approval', approved: true, message: '' },
  });
  store.markPendingBatchResuming('session-1', 'batch-1');

  await storage.recoverOrphanedRuns();
  const snapshot = await runtime.getSnapshot('session-1');

  assert.equal(store.getPendingInteraction('session-1', 'interaction-1').status, 'resolved');
  assert.equal(snapshot.state, 'suspended');
  assert.equal(snapshot.resume_interaction_id, 'interaction-1');
  assert.deepEqual(snapshot.pending_interactions, []);
  assert.deepEqual(snapshot.allowed_actions, ['resume_run', 'stop_run']);
});

test('Local 崩溃恢复对无可恢复交互的 run 使用 interrupted', async (t) => {
  const { store, storage, runtime } = await createHarness(t);
  store.addMessage({
    messageId: 'run-1:intent:0',
    sessionId: 'session-1',
    role: 'assistant',
    content: '正在执行命令',
    contentParts: [{ type: 'text', text: '正在执行命令' }],
    threadKey: 'root',
    toolCalls: [{
      id: 'call-recovery-1',
      type: 'function',
      function: { name: 'execute_bash', arguments: '{"command":"pwd"}' },
    }],
    metadata: { run_id: 'run-1', round: 1, agent_name: 'root' },
  });

  const recovered = await storage.recoverOrphanedRuns();
  const snapshot = await runtime.getSnapshot('session-1');

  assert.deepEqual(recovered.interruptedRuns, [{ runId: 'run-1', parentRunId: null }]);
  assert.equal(store.getRun('session-1', 'run-1').status, 'interrupted');
  assert.match(
    store.getMessageById('session-1', store.getRun('session-1', 'run-1').final_message_id).content,
    /本次运行已中断/,
  );
  assert.equal(
    store.getRecentMessages('session-1', 100, 'root')
      .some((message) => message.role === 'tool' && message.tool_call_id === 'call-recovery-1'),
    true,
  );
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.last_run.status, 'interrupted');
  assert.equal(snapshot.last_run.reason, 'backend_restarted');
});

test('中断终态会关闭悬空 tool call 并写入 tool_result 事件', async (t) => {
  const { store, storage } = await createHarness(t);
  store.addMessage({
    messageId: 'run-1:intent:0',
    sessionId: 'session-1',
    role: 'assistant',
    content: '正在执行命令',
    contentParts: [{ type: 'text', text: '正在执行命令' }],
    threadKey: 'root',
    toolCalls: [{
      id: 'call-bash-1',
      type: 'function',
      function: { name: 'execute_bash', arguments: '{"command":"find /"}' },
    }],
    metadata: { run_id: 'run-1', round: 1, agent_name: 'root' },
  });

  const result = await storage.operations.finalizeRun({
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'interrupted',
    finalMessage: buildTerminalAssistantMessage({
      sessionId: 'session-1',
      runId: 'run-1',
      threadKey: 'root',
      agentName: 'root',
      terminalStatus: 'interrupted',
      reason: 'user stopped the run',
    }),
    closeDanglingToolCalls: {
      threadKey: 'root',
      agentName: 'root',
      terminalStatus: 'interrupted',
      reason: 'user stopped the run',
    },
  });

  const closed = store.getRecentMessages('session-1', 100, 'root')
    .find((message) => message.role === 'tool' && message.tool_call_id === 'call-bash-1');
  assert.equal(closed?.metadata.terminal_tool_result, true);
  assert.equal(closed?.metadata.terminal_status, 'interrupted');
  assert.equal(closed?.metadata.terminal_reason, 'user stopped the run');
  assert.equal(closed?.content, '工具执行被中断：user stopped the run');
  assert.equal(result.records.length, 5);
  const toolResult = result.records.find(record => record.outbox.event_type === 'client.tool_result');
  assert.equal(toolResult?.outbox.event_type, 'client.tool_result');
  assert.equal(JSON.parse(toolResult.outbox.payload).client_event.payload.status, 'interrupted');
  assert.equal(store.getRun('session-1', 'run-1').status, 'interrupted');
  assert.equal(store.getRun('session-1', 'run-1').terminal_reason, 'user stopped the run');
});

test('failed 终态会关闭悬空 tool call 并保留失败原因', async (t) => {
  const { store, storage, runtime } = await createHarness(t);
  store.addMessage({
    messageId: 'run-1:intent:0',
    sessionId: 'session-1',
    role: 'assistant',
    content: '正在调用模型工具',
    contentParts: [{ type: 'text', text: '正在调用模型工具' }],
    threadKey: 'root',
    toolCalls: [{
      id: 'call-provider-1',
      type: 'function',
      function: { name: 'search', arguments: '{}' },
    }],
    metadata: { run_id: 'run-1', round: 1, agent_name: 'root' },
  });

  const finalizeInput = {
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'failed',
    finalMessage: buildTerminalAssistantMessage({
      sessionId: 'session-1',
      runId: 'run-1',
      threadKey: 'root',
      agentName: 'root',
      terminalStatus: 'failed',
      reason: 'provider stream disconnected',
    }),
    closeDanglingToolCalls: {
      threadKey: 'root',
      agentName: 'root',
      terminalStatus: 'failed',
      reason: 'provider stream disconnected',
    },
  };
  await storage.operations.finalizeRun(finalizeInput);
  await storage.operations.finalizeRun(finalizeInput);
  await assert.rejects(
    storage.operations.finalizeRun({
      ...finalizeInput,
      closeDanglingToolCalls: {
        ...finalizeInput.closeDanglingToolCalls,
        reason: 'different failure reason',
      },
    }),
    /run terminal reason conflicts with idempotent finalize/,
  );

  const closed = store.getRecentMessages('session-1', 100, 'root')
    .find((message) => message.role === 'tool' && message.tool_call_id === 'call-provider-1');
  assert.equal(closed?.metadata.terminal_status, 'failed');
  assert.equal(closed?.metadata.terminal_reason, 'provider stream disconnected');
  assert.equal(closed?.content, '工具执行因 Run 失败而终止：provider stream disconnected');
  assert.equal(store.getRun('session-1', 'run-1').status, 'failed');
  assert.equal(store.getRun('session-1', 'run-1').terminal_reason, 'provider stream disconnected');

  const failedSnapshot = await runtime.getSnapshot('session-1');
  assert.equal(failedSnapshot.state, 'idle');
  assert.equal(failedSnapshot.last_run.reason, 'provider stream disconnected');
  assert.deepEqual(failedSnapshot.allowed_actions, ['send_message', 'start_maintenance']);

  const started = await storage.operations.startOrAppendRoot({
    session: {
      sessionId: 'session-1',
      ownerUserId: 'usr_test',
      visibility: 'private',
      originType: 'direct',
      originId: null,
      originChannel: 'web',
      workspaceId: null,
      teamSnapshot,
      metadata: {},
    },
    run: {
      runId: 'run-2',
      sessionId: 'session-1',
      status: 'running',
      taskSummary: 'next task',
      requestId: 'req-2',
      agentName: 'root',
      agentCallId: 'root-call-2',
      lineageParentCallId: null,
      agentDisplayName: 'Root',
      leaseRootRunId: 'run-2',
      threadKey: 'root',
    },
    initialUserMessage: {
      messageId: 'run-2:user',
      sessionId: 'session-1',
      role: 'user',
      content: '继续新任务',
      contentParts: [{ type: 'text', text: '继续新任务' }],
      threadKey: 'root',
      metadata: { run_id: 'run-2' },
    },
    followupFactory: () => {
      throw new Error('no active run should receive a followup');
    },
  });
  assert.equal(started.kind, 'started');
  const history = store.getRecentMessages('session-1', 100, 'root');
  const toolIndex = history.findIndex((message) => message.tool_call_id === 'call-provider-1');
  const nextUserIndex = history.findIndex((message) => message.id === 'run-2:user');
  assert.equal(toolIndex >= 0 && nextUserIndex > toolIndex, true);
});

test('root 终态原子收敛共享 lease child，并保留独立 background child', async (t) => {
  const { store, storage } = await createHarness(t);
  store.createRun({
    runId: 'foreground-child',
    sessionId: 'session-1',
    status: 'suspended',
    agentName: 'worker',
    agentCallId: 'foreground-call',
    lineageParentCallId: 'root-call-1',
    agentDisplayName: 'Worker',
    leaseRootRunId: 'run-1',
    threadKey: 'child:foreground',
    parentRunId: 'run-1',
    parentCallId: 'invoke-foreground',
    childAgentId: 'foreground-agent',
  });
  store.createRun({
    runId: 'background-child',
    sessionId: 'session-1',
    status: 'running',
    agentName: 'worker',
    agentCallId: 'background-call',
    lineageParentCallId: 'root-call-1',
    agentDisplayName: 'Worker',
    leaseRootRunId: 'background-child',
    threadKey: 'child:background',
    parentRunId: 'run-1',
    parentCallId: 'invoke-background',
    childAgentId: 'background-agent',
  });

  const result = await storage.operations.finalizeRun({
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'interrupted',
    reason: 'session_stopped',
    finalMessage: buildTerminalAssistantMessage({
      sessionId: 'session-1',
      runId: 'run-1',
      threadKey: 'root',
      agentName: 'root',
      terminalStatus: 'interrupted',
      reason: 'session_stopped',
    }),
  });

  assert.equal(store.getRun('session-1', 'run-1').status, 'interrupted');
  assert.equal(store.getRun('session-1', 'foreground-child').status, 'interrupted');
  assert.equal(store.getRun('session-1', 'background-child').status, 'running');
  const ended = result.records
    .map(record => JSON.parse(record.outbox.payload).client_event)
    .filter(event => event.type === 'agent_ended');
  assert.deepEqual(ended.map(event => event.call_id).sort(), ['foreground-call', 'root-call-1']);
  assert.deepEqual(ended.map(event => event.payload.status), ['interrupted', 'interrupted']);

  const lateFinalize = await storage.operations.finalizeRun({
    runId: 'foreground-child',
    sessionId: 'session-1',
    status: 'failed',
    reason: 'late child failure',
    finalMessage: buildTerminalAssistantMessage({
      sessionId: 'session-1',
      runId: 'foreground-child',
      threadKey: 'child:foreground',
      agentName: 'worker',
      terminalStatus: 'failed',
      reason: 'late child failure',
    }),
  });
  assert.equal(lateFinalize.records.length, 0);
  assert.equal(store.getRun('session-1', 'foreground-child').status, 'interrupted');
});

test('Local 崩溃恢复按持久化 lease root 收敛前台 child', async (t) => {
  const { store, storage } = await createHarness(t);
  store.createRun({
    runId: 'zz-foreground-child',
    sessionId: 'session-1',
    status: 'running',
    agentName: 'worker',
    agentCallId: 'zz-foreground-call',
    lineageParentCallId: 'root-call-1',
    agentDisplayName: 'Worker',
    leaseRootRunId: 'run-1',
    threadKey: 'child:zz-foreground',
    parentRunId: 'run-1',
    parentCallId: 'invoke-foreground',
    childAgentId: 'zz-foreground-agent',
  });

  const recovered = await storage.recoverOrphanedRuns();

  assert.deepEqual(recovered.interruptedRuns, [
    { runId: 'run-1', parentRunId: null },
    { runId: 'zz-foreground-child', parentRunId: 'run-1' },
  ]);
  assert.equal(store.getRun('session-1', 'run-1').status, 'interrupted');
  assert.equal(store.getRun('session-1', 'zz-foreground-child').status, 'interrupted');
  const ended = recovered.records
    .map(record => JSON.parse(record.outbox.payload).client_event)
    .filter(event => event.type === 'agent_ended');
  assert.deepEqual(ended.map(event => event.call_id), ['root-call-1', 'zz-foreground-call']);
});

test('Local 崩溃恢复把后台 child 作为独立交互根，并允许 child 独立续接', async (t) => {
  const { store, storage, runtime } = await createHarness(t);
  store.createRun({
    runId: 'child-run-1',
    sessionId: 'session-1',
    entrypoint: 'agent_stream',
    status: 'running',
    taskSummary: 'child task',
    requestId: 'child-req-1',
    agentName: 'worker',
    agentCallId: 'child-call-1',
    lineageParentCallId: 'root-call-1',
    agentDisplayName: 'Worker',
    leaseRootRunId: 'child-run-1',
    threadKey: 'child:child-1',
    parentRunId: 'run-1',
    parentCallId: 'parent-call-1',
    childAgentId: 'child-1',
  });
  store.createPendingInteraction({
    interactionId: 'child-interaction-1',
    sessionId: 'session-1',
    runId: 'child-run-1',
    rootRunId: 'child-run-1',
    toolCallId: 'child-tool-1',
    batchId: 'child-batch-1',
    kind: 'user_input',
    requestPayload: {
      rootCallId: 'child-call-1',
      task: 'child task',
      interaction_payload: {
        kind: 'user_input',
        phase: 'required',
        prompt: '继续吗？',
      },
    },
  });

  const recovered = await storage.recoverOrphanedRuns();
  assert.deepEqual(recovered.interruptedRuns, [{ runId: 'run-1', parentRunId: null }]);
  assert.deepEqual(recovered.suspendedRuns, [{ runId: 'child-run-1', parentRunId: 'run-1' }]);
  assert.equal(store.getRun('session-1', 'run-1').status, 'interrupted');
  assert.equal(store.getRun('session-1', 'child-run-1').status, 'suspended');

  const snapshot = await runtime.getSnapshot('session-1');
  assert.equal(snapshot.state, 'suspended');
  assert.equal(snapshot.active_run.run_id, 'child-run-1');
  assert.equal(snapshot.pending_interactions[0].root_run_id, 'child-run-1');

  store.updatePendingInteractionStatus({
    sessionId: 'session-1',
    interactionId: 'child-interaction-1',
    from: ['suspended'],
    status: 'resolved',
    resolution: { kind: 'user_input', value: '继续' },
  });
  const claim = await storage.operations.claimResume({
    sessionId: 'session-1',
    interactionId: 'child-interaction-1',
    claimId: 'child-claim-1',
    leaseMs: 60_000,
  });
  assert.equal(claim.claimed, true);
  assert.equal(claim.rootRunId, 'child-run-1');
  assert.equal(claim.parentRunId, 'run-1');
});

test('恢复同一 run 时 intent 必须续用下一逻辑轮次，不能覆盖旧 intent:0', async (t) => {
  const { store, storage } = await createHarness(t);
  const base = {
    sessionId: 'session-1',
    role: 'assistant',
    threadKey: 'root',
    contentParts: [],
    metadata: {
      run_id: 'run-1',
      agent: 'root',
      agent_name: 'root',
      thread_key: 'root',
      conversation_scope: 'root',
      react_intermediate: true,
      visible_to_user: true,
      msg_type: 'intent',
    },
  };

  await storage.operations.persistMessage({
    leaseRootRunId: 'run-1',
    message: {
      ...base,
      messageId: 'run-1:intent:0',
      content: 'first intent',
      contentParts: [{ type: 'text', text: 'first intent' }],
      metadata: { ...base.metadata, round: 1 },
    },
  });

  await assert.rejects(
    storage.operations.persistMessage({
      leaseRootRunId: 'run-1',
      message: {
        ...base,
        messageId: 'run-1:intent:0',
        content: 'resumed intent',
        contentParts: [{ type: 'text', text: 'resumed intent' }],
        metadata: { ...base.metadata, round: 1 },
      },
    }),
    /message deterministic id conflict: run-1:intent:0/,
  );

  const resumed = await storage.operations.persistMessage({
    leaseRootRunId: 'run-1',
    message: {
      ...base,
        messageId: 'run-1:intent:1',
        content: 'resumed intent',
        contentParts: [{ type: 'text', text: 'resumed intent' }],
      metadata: { ...base.metadata, round: 2 },
    },
  });

  assert.equal(resumed.message.id, 'run-1:intent:1');
  assert.equal(store.getMessageById('session-1', 'run-1:intent:0').content, 'first intent');
  assert.equal(store.getMessageById('session-1', 'run-1:intent:1').content, 'resumed intent');
});

test('Local resume claim attach 后立即从 resuming 投影为 running', async (t) => {
  const { store, storage, runtime } = await createHarness(t);
  const claim = await createResumeClaim(store, storage);

  const claimedSnapshot = await runtime.getSnapshot('session-1');
  assert.equal(claimedSnapshot.state, 'resuming');
  assert.deepEqual(claimedSnapshot.allowed_actions, ['stop_run']);

  const attached = await storage.operations.attachResume({
    sessionId: 'session-1',
    rootRunId: 'run-1',
    claimId: claim.claimId,
    batchId: claim.batchId,
    record: resumeAttachRecord(claim.claimId),
  });
  const attachedSnapshot = await runtime.getSnapshot('session-1');

  assert.equal(attached.attached, true);
  assert.equal(store.getPendingInteraction('session-1', 'interaction-1').status, 'resolved');
  assert.equal(attachedSnapshot.state, 'running');
  assert.deepEqual(attachedSnapshot.allowed_actions, ['send_followup', 'stop_run']);
});

test('Local attach 后启动器同步失败可回滚为 suspended 且保留 resume_run', async (t) => {
  const { store, storage, runtime } = await createHarness(t);
  const claim = await createResumeClaim(store, storage);
  const attached = await storage.operations.attachResume({
    sessionId: 'session-1',
    rootRunId: 'run-1',
    claimId: claim.claimId,
    batchId: claim.batchId,
    record: resumeAttachRecord(claim.claimId),
  });
  assert.equal(attached.attached, true);

  const rolledBack = await storage.operations.rollbackResume({
    sessionId: 'session-1',
    rootRunId: 'run-1',
    claimId: claim.claimId,
    batchId: claim.batchId,
  });
  const snapshot = await runtime.getSnapshot('session-1');

  assert.equal(rolledBack.rolledBack, true);
  assert.equal(store.getRun('session-1', 'run-1').status, 'suspended');
  assert.equal(snapshot.state, 'suspended');
  assert.deepEqual(snapshot.pending_interactions, []);
  assert.deepEqual(snapshot.allowed_actions, ['resume_run', 'stop_run']);
});

test('Local claim 被恢复回滚后不能伪装成已 attach', async (t) => {
  const { store, storage } = await createHarness(t);
  const claim = await createResumeClaim(store, storage);

  const recovered = await storage.operations.recoverExpiredResumeClaims({
    sessionId: 'session-1',
    now: '2999-01-01T00:00:00.000Z',
  });
  const attached = await storage.operations.attachResume({
    sessionId: 'session-1',
    rootRunId: 'run-1',
    claimId: claim.claimId,
    batchId: claim.batchId,
    record: resumeAttachRecord(claim.claimId),
  });

  assert.deepEqual(recovered.recoveredClaimIds, [claim.claimId]);
  assert.equal(store.getRun('session-1', 'run-1').status, 'suspended');
  assert.equal(attached.attached, false);
});
