import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresConversationRepository } from '../dist/adapters/saas/postgres/conversation-repository.js';

test('Postgres scopes both count and page queries to the requested execution runs and thread', async () => {
  const queries = [];
  const repository = new PostgresConversationRepository({
    async query(sql, params) {
      queries.push({ sql, params: structuredClone(params) });
      return sql.startsWith('SELECT COUNT') ? { rows: [{ total: 7 }] } : { rows: [] };
    },
  });
  const result = await repository.listMessages('session-1', 2, 3, 'root', ['run-1', 'run-2']);
  assert.equal(result.total, 7);
  assert.equal(result.has_more, true);
  assert.equal(queries.length, 2);
  for (const { sql, params } of queries) {
    assert.match(sql, /session_id=\$1 AND \(\$2::text IS NULL OR thread_key=\$2\)/);
    // JSONB nullish coalescing also preserves types: numeric/object owners cannot match string run IDs.
    assert.match(sql, /COALESCE\(NULLIF\(metadata->'consumed_by_run_id', 'null'::jsonb\), metadata->'run_id'\) = ANY\(\$3::jsonb\[\]\)/);
    assert.deepEqual(params.slice(0, 3), ['session-1', 'root', ['"run-1"', '"run-2"']]);
  }
  assert.deepEqual(queries[0].params, ['session-1', 'root', ['"run-1"', '"run-2"']]);
  assert.deepEqual(queries[1].params.slice(3), [2, 3]);
  assert.match(queries[1].sql, /LIMIT \$4 OFFSET \$5/);
  queries.length = 0;
  assert.deepEqual(await repository.listMessages('session-1', 2, 0, 'root', []), {
    items: [], total: 0, limit: 2, offset: 0, has_more: false,
  });
  assert.equal(queries.length, 0);
  await repository.listMessages('session-1', 2, 3, 'root');
  assert.deepEqual(queries[1].params, ['session-1', 'root', 2, 3]);
  assert.match(queries[1].sql, /LIMIT \$3 OFFSET \$4/);
  assert.doesNotMatch(queries[1].sql, /consumed_by_run_id/);
});
