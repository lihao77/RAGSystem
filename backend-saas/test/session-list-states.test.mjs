import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresRuntimeStorage } from '../dist/adapters/saas/postgres/postgres-runtime-storage.js';
import { SessionRuntimeService } from '@ragsystem/backend-core/services/runtime/session-runtime-service.js';
import { PostgresConversationRepository } from '../dist/adapters/saas/postgres/conversation-repository.js';

test('SaaS list states use one tenant-scoped batch without full runtime or event reads', async () => {
  const calls = [];
  const executor = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [
      { session_id: 'a', metadata: {}, active_status: 'running', pending_statuses: [] },
      { session_id: 'b', metadata: {}, active_status: 'suspended', pending_statuses: ['suspended'] },
      { session_id: 'c', metadata: {}, active_status: null, pending_statuses: [] },
    ] };
  } };
  const service = new SessionRuntimeService(new PostgresRuntimeStorage('tnt_test', executor));
  assert.deepEqual([...await service.getStates(['a', 'b', 'c', 'a'])], [['a', 'running'], ['b', 'suspended'], ['c', 'idle']]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['tnt_test', ['a', 'b', 'c']]);
  assert.match(calls[0].sql, /s\.tenant_id=\$1/);
  assert.doesNotMatch(calls[0].sql, /outbox|run_steps/);
  await service.getStates([]);
  assert.equal(calls.length, 1);
});

test('SaaS pin restoration retains tenant and visibility filters alongside ID selection', async () => {
  const calls = [];
  const repo = new PostgresConversationRepository({ query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } });
  await repo.listSessions({ tenantId: 'tnt_test', access: { userId: 'usr_test', includeTenant: false }, limit: 200, sessionIds: ['a', 'b'] });
  assert.deepEqual(calls[0].params.slice(0, 5), ['tnt_test', 'usr_test', false, false, ['a', 'b']]);
  assert.match(calls[0].sql, /tenant_id=\$1/);
  assert.match(calls[0].sql, /owner_user_id=\$2/);
  assert.match(calls[0].sql, /session_id=ANY\(\$5::text\[\]\)/);
});

test('SaaS batch state metadata hydrates empty and reserved-key shapes before projection', async () => {
  const maintenance = { runtime_maintenance: { kind: 'compact', expires_at: '2099-01-01T00:00:00Z' } };
  const fixtures = [
    [null, {}], [42, {}], ['legacy', {}], [[], {}],
    [{ team: 'legacy', entry_agent: 'root', marker: 'kept' }, { marker: 'kept' }],
    [maintenance, maintenance],
  ];
  const rows = fixtures.map(([metadata], index) => ({ session_id: `metadata-${index}`, metadata, active_status: null, pending_statuses: [] }));
  const storage = new PostgresRuntimeStorage('tnt_test', { query: async () => ({ rows }) });
  const ids = rows.map(row => row.session_id);
  const facts = await storage.operations.getSessionStateFacts(ids);
  assert.deepEqual(facts.map(entry => entry.metadata), fixtures.map(([, expected]) => expected));
  const states = await new SessionRuntimeService(storage).getStates(ids);
  assert.deepEqual([...states], ids.map((id, index) => [id, index === ids.length - 1 ? 'maintenance' : 'idle']));
});
