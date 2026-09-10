import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { computeSessionTeamRevision } from '@ragsystem/backend-core/contracts/session/session.js';
import { createConversationStore } from '../dist/adapters/local/sqlite/conversation-store/index.js';

function session(store, sessionId = 'session-1') {
  const agents = { assistant: { agent_name: 'assistant' } };
  store.createSession({ tenantId: 'tnt_test', sessionId, ownerUserId: 'usr_test', visibility: 'private', originType: 'direct',
    originId: null, originChannel: 'web', workspaceId: null, metadata: {}, teamSnapshot: {
      team_name: 'default', team_revision: computeSessionTeamRevision(agents), entry_agent_name: 'assistant', agents,
    } });
}

test('receipts survive reopen, reject duplicate sends and reconcile canonical consumption', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-request-test-'));
  const options = { dbPath: join(directory, 'conversation.db'), dataRoot: directory };
  let store = createConversationStore(options);
  try {
    session(store);
    session(store, 'session-2');
    assert.equal(store.beginMessageRequest('session-1', 'req-1', '补充'), true);
    store.settleMessageRequest('session-1', 'req-1', 'failed', '插件处理失败');
    store.close();
    store = createConversationStore(options);
    assert.equal(store.beginMessageRequest('session-1', 'req-1', '重复补充'), false);
    assert.equal(store.listMessageRequestStatuses('session-1', ['req-1'])[0].error, '插件处理失败');
    assert.deepEqual(store.listMessageRequestStatuses('session-2', ['req-1']), []);
    assert.equal(store.beginMessageRequest('session-1', 'req-2', '下一条'), true);
    store.settleMessageRequest('session-1', 'req-2', 'queued');
    assert.equal(store.listMessageRequestStatuses('session-1')[0].status, 'queued');
    store.addMessage({ sessionId: 'session-1', messageId: 'user-2', role: 'user', contentParts: [{ type: 'text', text: '下一条' }], metadata: { request_id: 'req-2' } });
    assert.deepEqual(store.listMessageRequestStatuses('session-1'), []);
    store.beginMessageRequest('session-1', 'lost', '未入队');
    store.beginMessageRequest('session-1', 'alive', '仍在处理');
    const raw = new DatabaseSync(options.dbPath);
    raw.prepare("UPDATE session_message_requests SET updated_at='2000-01-01T00:00:00.000Z' WHERE request_id IN ('lost', 'alive')").run();
    raw.close();
    store.renewMessageRequest('session-1', 'alive');
    const recovered = store.listMessageRequestStatuses('session-1', ['lost', 'alive']);
    assert.equal(recovered.find(item => item.request_id === 'lost').status, 'failed');
    assert.equal(recovered.find(item => item.request_id === 'alive').status, 'processing');
    store.settleMessageRequest('session-1', 'alive', 'failed', 'test complete');
    const consumed = store.listMessageRequestStatuses('session-1', ['req-2'])[0];
    assert.equal(consumed.status, 'consumed');
    assert.equal(consumed.message_id, 'user-2');
    store.deleteMessagesAfter('session-1', { afterSeq: 0 });
    assert.equal(store.listMessageRequestStatuses('session-1', ['req-2'])[0].status, 'consumed');
    assert.deepEqual(store.listMessageRequestStatuses('session-1'), []);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const fixture of [
  { name: 'missing table', fields: null },
  { name: 'missing columns', fields: {} },
  { name: 'queued without content column', fields: { status: 'queued' } },
  { name: 'unknown with null content', fields: { status: 'unknown', content: null } },
  { name: 'null fields', fields: { status: null, content: null, updated_at: null } },
  { name: 'invalid status', fields: { status: 'legacy', content: '' } },
  { name: 'failed without content', fields: { status: 'failed', content: null }, status: 'failed' },
  { name: 'consumed without content', fields: { status: 'consumed', content: '' }, status: 'consumed' },
  { name: 'valid content and timestamp', fields: { status: 'queued', content: '已记录的原文', updated_at: '2025-01-01T00:00:00.000Z' } },
]) test(`current-version receipt hydration converges: ${fixture.name}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-request-hydrate-'));
  const options = { dbPath: join(directory, 'conversation.db'), dataRoot: directory };
  let store = createConversationStore(options);
  try {
    session(store);
    await store.agentMailbox.enqueue({ tenantId: 'tnt_test', sessionId: 'session-1', messageId: 'mail-1',
      targetThreadKey: 'root', kind: 'request', inputType: 'user_message', sourceKind: 'user', visibleToUser: true,
      contentParts: [{ type: 'text', text: '旧排队消息' }], metadata: { request_id: 'legacy-1' } });
    store.close();
    const raw = new DatabaseSync(options.dbPath);
    raw.exec('DROP TABLE session_message_requests');
    if (fixture.fields !== null) {
      const columns = ['session_id', 'request_id', ...Object.keys(fixture.fields)];
      raw.exec(`CREATE TABLE session_message_requests(${columns.map(column => `${column} TEXT`).join(', ')}, PRIMARY KEY(session_id, request_id))`);
      raw.prepare(`INSERT INTO session_message_requests(${columns.join(', ')}) VALUES(${columns.map(() => '?').join(', ')})`)
        .run('session-1', 'legacy-1', ...Object.values(fixture.fields));
    }
    raw.close();
    store = createConversationStore(options);
    const expectedStatus = fixture.status ?? 'queued';
    const receipt = store.listMessageRequestStatuses('session-1', ['legacy-1'])[0];
    assert.equal(receipt.content, fixture.fields?.content || '旧排队消息');
    assert.equal(receipt.status, expectedStatus);
    assert.ok(receipt.updated_at);
    if (fixture.fields?.updated_at) assert.equal(receipt.updated_at, fixture.fields.updated_at);
    assert.deepEqual(store.listMessageRequestStatuses('session-1', ['legacy-1']), [receipt]);
    assert.equal(store.listMessageRequestStatuses('session-1').length, expectedStatus === 'queued' ? 1 : 0);
    const hydrated = new DatabaseSync(options.dbPath);
    const persisted = hydrated.prepare('SELECT content, status FROM session_message_requests WHERE request_id=?').get('legacy-1');
    hydrated.close();
    assert.equal(persisted.content, receipt.content);
    assert.equal(persisted.status, expectedStatus);
    store.close();
    store = createConversationStore(options);
    assert.deepEqual(store.listMessageRequestStatuses('session-1', ['legacy-1']), [receipt]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
