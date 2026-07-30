import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createTenantId } from '@ragsystem/backend-core/identity/types.js';
import { SessionRuntimeService } from '@ragsystem/backend-core/services/runtime/session-runtime-service.js';
import { createConversationStore } from '../dist/adapters/local/sqlite/conversation-store/index.js';
import { SqliteRuntimeStorage } from '../dist/adapters/local/sqlite-runtime-storage.js';

const tenantId = createTenantId('tnt_test');

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

function terminalRecord({ sessionId, runId, status, reason }) {
  return {
    outbox: {
      eventId: `recovery-${runId}`,
      sessionId,
      runId,
      eventType: 'run_ended',
      aggregateType: 'run',
      aggregateId: runId,
      payload: {
        type: 'run_ended',
        session_id: sessionId,
        run_id: runId,
        payload: { status, reason },
      },
    },
  };
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

  const recovered = await storage.recoverOrphanedRuns(terminalRecord);
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

  await storage.recoverOrphanedRuns(terminalRecord);
  const snapshot = await runtime.getSnapshot('session-1');

  assert.equal(store.getPendingInteraction('session-1', 'interaction-1').status, 'resolved');
  assert.equal(snapshot.state, 'suspended');
  assert.equal(snapshot.resume_interaction_id, 'interaction-1');
  assert.deepEqual(snapshot.pending_interactions, []);
  assert.deepEqual(snapshot.allowed_actions, ['resume_run', 'stop_run']);
});

test('Local 崩溃恢复对无可恢复交互的 run 使用 interrupted', async (t) => {
  const { store, storage, runtime } = await createHarness(t);

  const recovered = await storage.recoverOrphanedRuns(terminalRecord);
  const snapshot = await runtime.getSnapshot('session-1');

  assert.deepEqual(recovered.interruptedRuns, [{ runId: 'run-1', parentRunId: null }]);
  assert.equal(store.getRun('session-1', 'run-1').status, 'interrupted');
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.last_run.status, 'interrupted');
});

test('恢复同一 run 时 intent 必须续用下一逻辑轮次，不能覆盖旧 intent:0', async (t) => {
  const { store, storage } = await createHarness(t);
  const base = {
    sessionId: 'session-1',
    role: 'assistant',
    threadKey: 'root',
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
