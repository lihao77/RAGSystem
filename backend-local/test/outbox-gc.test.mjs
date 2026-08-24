import assert from 'node:assert/strict';
import test from 'node:test';

import { createTenantId } from '@ragsystem/backend-core/identity/types.js';
import { computeSessionTeamRevision } from '@ragsystem/backend-core/contracts/session/session.js';
import { createConversationStore } from '../dist/adapters/local/sqlite/conversation-store/index.js';

const tenantId = createTenantId('tnt_test');
const agents = { root: { agent_name: 'root' } };
const teamSnapshot = { team_name: 'test', team_revision: computeSessionTeamRevision(agents), entry_agent_name: 'root', agents };

test('deleteDeliveredOutbox 清理终态 run 的老行，保护非终态 run 的回放源与未投递行', (t) => {
  const store = createConversationStore({ dbPath: ':memory:', dataRoot: process.cwd() });
  t.after(() => store.close());
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
  const createRun = (runId) => store.createRun({
    runId,
    sessionId: 'session-1',
    entrypoint: 'agent_stream',
    status: 'running',
    taskSummary: 'task',
    requestId: `req-${runId}`,
    userId: null,
    agentName: 'root',
    agentCallId: `call-${runId}`,
    lineageParentCallId: null,
    agentDisplayName: 'Root',
    leaseRootRunId: runId,
    threadKey: 'root',
    parentRunId: null,
    parentCallId: null,
    childAgentId: null,
  });
  createRun('run-active');
  createRun('run-done');
  store.updateRunStatus('run-done', 'session-1', 'completed');

  // before 取未来时刻 → 时间谓词全命中，隔离出 run 状态谓词的语义。
  const before = new Date(Date.now() + 60_000).toISOString();
  const appendDelivered = (eventId, runId) => {
    const row = store.appendOutbox({
      sessionId: 'session-1',
      runId,
      eventId,
      eventType: 'client.tool_call',
      aggregateType: 'run',
      aggregateId: runId ?? 'session-1',
      payload: { client_event: { type: 'tool_call' } },
    });
    store.markOutboxDelivered(row.id);
    return row;
  };
  const activeRow = appendDelivered('evt-active', 'run-active');
  const doneRow = appendDelivered('evt-done', 'run-done');
  const runlessRow = appendDelivered('evt-none', null);
  const pendingRow = store.appendOutbox({
    sessionId: 'session-1',
    runId: 'run-done',
    eventId: 'evt-pending',
    eventType: 'client.tool_result',
    aggregateType: 'run',
    aggregateId: 'run-done',
    payload: { client_event: { type: 'tool_result' } },
  });

  const deleted = store.deleteDeliveredOutbox({ before, limit: 100 });

  assert.equal(deleted, 2);
  assert.ok(store.getOutboxRow(activeRow.id), 'running run 的 delivered 行受保护（attach 回放源）');
  assert.equal(store.getOutboxRow(doneRow.id), null, '终态 run 的 delivered 行被清理');
  assert.equal(store.getOutboxRow(runlessRow.id), null, '无 run 归属的 delivered 行被清理');
  assert.ok(store.getOutboxRow(pendingRow.id), '未投递行不受 GC 影响');
});
