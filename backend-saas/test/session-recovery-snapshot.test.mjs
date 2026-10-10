import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresRuntimeStorage } from '../dist/adapters/saas/postgres/postgres-runtime-storage.js';
import { computeSessionTeamRevision } from '@ragsystem/backend-core/contracts/session/session.js';

const agents = { root: { agent_name: 'root' } };

test('recovery uses one read-only repeatable-read transaction without row locks or repair writes', async () => {
  const calls = [];
  const tx = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (/^SELECT tenant_id FROM conversation_sessions/.test(sql)) return { rows: [{ tenant_id: 'tnt_test' }] };
    if (/^SELECT \* FROM conversation_sessions/.test(sql)) return { rows: [{ session_id: 'session-1', tenant_id: 'tnt_test',
      team_snapshot: { team_name: 'test', team_revision: computeSessionTeamRevision(agents), entry_agent_name: 'root', agents },
      metadata: {}, created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z' }] };
    if (/AS watermark/.test(sql)) return { rows: [{ watermark: 42 }] };
    if (/AS outbox_watermark/.test(sql)) return { rows: [{ items: [], total: 0, outbox_watermark: 42 }] };
    return { rows: [] };
  } };
  let transactions = 0;
  const storage = new PostgresRuntimeStorage('tnt_test', {
    query: async () => { throw new Error('read escaped the snapshot transaction'); },
    transaction: async fn => { transactions++; return fn(tx); },
  });
  const facts = await storage.operations.getSessionRecoveryFacts('session-1');
  assert.equal(transactions, 1);
  assert.equal(calls[0].sql, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(facts.eventWatermark, 42);
  assert.equal(facts.session.session_id, 'session-1');
  assert.deepEqual(facts.messages, []);
  assert.deepEqual(facts.activeRunEvents, []);
  assert.ok(calls.some(call => /session_message_requests/.test(call.sql)));
  assert.doesNotMatch(calls.map(call => call.sql).join('\n'), /FOR UPDATE|INSERT INTO|UPDATE session_message_requests|pg_advisory/);
});
