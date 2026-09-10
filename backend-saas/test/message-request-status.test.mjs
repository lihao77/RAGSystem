import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresConversationRepository } from '../dist/adapters/saas/postgres/conversation-repository.js';
import { hydrateMessageRequestSchema } from '../dist/adapters/saas/postgres/message-request-hydration.js';

test('Postgres send receipts scope reads/writes and legacy hydration to the session', async () => {
  const queries = [];
  const executor = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.includes('RETURNING request_id')) return { rows: [{ request_id: 'r1' }] };
    if (sql.startsWith('SELECT r.request_id')) return { rows: [{ request_id: 'r1', status: 'failed', content: '补充', error: 'failed', updated_at: new Date(0) }] };
    return { rows: [] };
  } };
  const repository = new PostgresConversationRepository(executor);
  assert.equal(await repository.beginMessageRequest('s1', 'r1', '补充'), true);
  await repository.settleMessageRequest('s1', 'r1', 'failed', 'failed');
  const receipts = await repository.listMessageRequestStatuses('s1', ['r1']);
  assert.equal(receipts[0].updated_at, new Date(0).toISOString());
  assert.deepEqual(queries[0].params, ['s1', 'r1', '补充']);
  assert.deepEqual(queries[1].params, ['s1', 'r1', 'failed', 'failed']);
  assert.match(queries[1].sql, /session_id=\$1 AND request_id=\$2 AND status='processing'/);
  assert.match(queries[2].sql, /INTERVAL '2 minutes'/);
  assert.deepEqual(queries[2].params, ['s1']);
  assert.match(queries[3].sql, /ON CONFLICT\(session_id, request_id\) DO UPDATE/);
  assert.match(queries[3].sql, /THEN session_message_requests.status ELSE excluded.status END/);
  assert.match(queries[3].sql, /content=COALESCE\(NULLIF\(session_message_requests.content, ''\), excluded.content\)/);
  assert.match(queries[3].sql, /OR session_message_requests.content IS NULL OR session_message_requests.content=''/);
  assert.deepEqual(queries[4].params, ['s1', ['r1']]);
  assert.match(queries[4].sql, /WHEN m.id IS NOT NULL OR r.status='consumed' THEN 'consumed'/);
  assert.match(queries[4].sql, /WHEN r.status='failed' OR b.status='expired' THEN 'failed'/);
});

test('Postgres initializes absent and partial receipt schemas without version gating', async () => {
  const queries = [];
  const executor = { async query(sql) { queries.push(sql); return { rows: [] }; } };
  await hydrateMessageRequestSchema(executor);
  await hydrateMessageRequestSchema(executor);
  assert.equal(queries[0], queries[1]);
  assert.match(queries[0], /CREATE TABLE IF NOT EXISTS session_message_requests/);
  for (const column of ['content', 'status', 'error', 'updated_at']) assert.ok(queries[0].includes(`ADD COLUMN IF NOT EXISTS ${column}`));
});
