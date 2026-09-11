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

async function queued(store, requestId, content = '原文', sessionId = 'session-1') {
  store.beginMessageRequest(sessionId, requestId, content);
  await store.agentMailbox.enqueue({ tenantId: 'tnt_test', sessionId, messageId: `${sessionId}:${requestId}`,
    targetThreadKey: 'root', kind: 'request', inputType: 'user_message', sourceKind: 'user', visibleToUser: true,
    contentParts: [{ type: 'text', text: content }], metadata: { request_id: requestId } });
  store.settleMessageRequest(sessionId, requestId, 'queued');
}

test('cancelling pending inputs updates the actual mailbox atomically and survives reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-request-actions-'));
  const options = { dbPath: join(directory, 'conversation.db'), dataRoot: directory };
  let store = createConversationStore(options);
  try {
    session(store);
    session(store, 'session-2');
    await queued(store, 'keep');
    await queued(store, 'delete');
    await queued(store, 'keep', '另一会话', 'session-2');
    assert.ok(store.listMessageRequestStatuses('session-1').every(row => row.can_manage));
    const input = { sessionId: 'session-1', requestId: 'delete', expectedContent: '原文' };
    assert.equal(store.cancelQueuedMessageRequest(input), true);
    assert.equal(store.cancelQueuedMessageRequest(input), false);
    assert.equal((await store.agentMailbox.get('session-2', 'session-2:keep')).content_parts[0].text, '另一会话');
    store.close();
    store = createConversationStore(options);
    assert.deepEqual(store.listMessageRequestStatuses('session-1').map(row => row.request_id), ['keep']);
    const cancelled = store.listMessageRequestStatuses('session-1', ['delete']).find(row => row.request_id === 'delete');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.error, null);
    assert.equal(cancelled.can_manage, false);
    const claimed = await store.agentMailbox.claim({ sessionId: 'session-1', targetThreadKey: 'root', claimId: 'claim', consumerId: 'consumer' });
    assert.deepEqual(claimed.map(row => row.message_id), ['session-1:keep']);
    assert.equal(store.listMessageRequestStatuses('session-1')[0].can_manage, false);
    assert.equal(store.cancelQueuedMessageRequest({ sessionId: 'session-1', requestId: 'keep', expectedContent: '原文' }), false);
    await store.agentMailbox.ack({ sessionId: 'session-1', messageId: claimed[0].message_id, claimId: 'claim' });
    assert.deepEqual(store.listMessageRequestStatuses('session-1'), []);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a receipt write failure rolls back the queue cancellation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-request-atomic-'));
  const options = { dbPath: join(directory, 'conversation.db'), dataRoot: directory };
  const store = createConversationStore(options);
  try {
    session(store);
    await queued(store, 'r1');
    const raw = new DatabaseSync(options.dbPath);
    raw.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON session_message_requests BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    raw.close();
    assert.throws(() => store.cancelQueuedMessageRequest({ sessionId: 'session-1', requestId: 'r1', expectedContent: '原文' }), /test failure/);
    const mailbox = await store.agentMailbox.get('session-1', 'session-1:r1');
    assert.equal(mailbox.status, 'queued');
    assert.equal(mailbox.content_parts[0].text, '原文');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('structured pending inputs can be cancelled without touching their payload', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-request-structured-'));
  const options = { dbPath: join(directory, 'conversation.db'), dataRoot: directory };
  const store = createConversationStore(options);
  try {
    session(store);
    await queued(store, 'command', '/review');
    const raw = new DatabaseSync(options.dbPath);
    raw.prepare('UPDATE agent_mailbox SET content_parts=? WHERE message_id=?')
      .run(JSON.stringify([{ type: 'command_ref', command: '/review' }]), 'session-1:command');
    raw.close();
    const receipt = store.listMessageRequestStatuses('session-1')[0];
    assert.equal(receipt.can_manage, true);
    assert.equal(store.cancelQueuedMessageRequest({ sessionId: 'session-1', requestId: 'command', expectedContent: '/review' }), true);
    assert.deepEqual(await store.agentMailbox.claim({ sessionId: 'session-1', targetThreadKey: 'root', claimId: 'claim', consumerId: 'consumer' }), []);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

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

test('historical queued receipts converge from durable consumption after rollback and reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-request-rollback-'));
  const options = { dbPath: join(directory, 'conversation.db'), dataRoot: directory };
  let store = createConversationStore(options);
  try {
    session(store);
    // This mailbox audit row survives rollback, while the original canonical user row is gone.
    await store.agentMailbox.enqueue({ tenantId: 'tnt_test', sessionId: 'session-1', messageId: 'old-user',
      targetThreadKey: 'root', kind: 'request', inputType: 'user_message', sourceKind: 'user', visibleToUser: true,
      contentParts: [{ type: 'text', text: '你好，继续' }], metadata: { request_id: 'old-request' } });
    await store.agentMailbox.settle({ sessionId: 'session-1', messageId: 'old-user' });
    store.beginMessageRequest('session-1', 'old-request', '你好，继续');
    store.settleMessageRequest('session-1', 'old-request', 'queued');

    // Old receipts can also have been written after a canonical message, before triggers existed.
    store.addMessage({ sessionId: 'session-1', messageId: 'historic-user', role: 'user',
      contentParts: [{ type: 'text', text: '已有历史消息' }], metadata: { request_id: 'historic-request' } });
    store.beginMessageRequest('session-1', 'historic-request', '已有历史消息');
    store.settleMessageRequest('session-1', 'historic-request', 'queued');
    store.close();
    store = createConversationStore(options);

    assert.deepEqual(store.listMessageRequestStatuses('session-1'), []);
    const receipts = store.listMessageRequestStatuses('session-1', ['old-request', 'historic-request']);
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every(receipt => receipt.status === 'consumed'));
    assert.equal(receipts.find(receipt => receipt.request_id === 'old-request').message_id, null);
    assert.equal(receipts.find(receipt => receipt.request_id === 'historic-request').message_id, 'historic-user');
    assert.deepEqual(store.listMessageRequestStatuses('session-1', ['old-request', 'historic-request']), receipts);

    store.deleteMessagesAfter('session-1', { afterSeq: 0 });
    const raw = new DatabaseSync(options.dbPath);
    assert.deepEqual(raw.prepare('SELECT DISTINCT status FROM session_message_requests').all().map(row => row.status), ['consumed']);
    raw.prepare('DELETE FROM agent_mailbox WHERE session_id=?').run('session-1');
    raw.close();
    store.close();
    store = createConversationStore(options);
    assert.deepEqual(store.listMessageRequestStatuses('session-1'), []);
    assert.ok(store.listMessageRequestStatuses('session-1', ['old-request', 'historic-request']).every(receipt => receipt.status === 'consumed'));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('mailbox acknowledgement recovery is scoped to the matching root user request and session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-request-ack-scope-'));
  const options = { dbPath: join(directory, 'conversation.db'), dataRoot: directory };
  const store = createConversationStore(options);
  try {
    session(store);
    session(store, 'session-2');
    for (const fixture of [
      { requestId: 'waiting', thread: 'root', inputType: 'user_message', sessionId: 'session-1', ack: false },
      { requestId: 'child', thread: 'child:a', inputType: 'user_message', sessionId: 'session-1', ack: true },
      { requestId: 'agent', thread: 'root', inputType: 'agent_message', sessionId: 'session-1', ack: true },
      { requestId: 'other-session', thread: 'root', inputType: 'user_message', sessionId: 'session-2', ack: true },
    ]) {
      store.beginMessageRequest('session-1', fixture.requestId, fixture.requestId);
      store.settleMessageRequest('session-1', fixture.requestId, 'queued');
      await store.agentMailbox.enqueue({ tenantId: 'tnt_test', sessionId: fixture.sessionId, messageId: fixture.requestId,
        targetThreadKey: fixture.thread, kind: 'request', inputType: fixture.inputType, sourceKind: 'user', visibleToUser: true,
        contentParts: [{ type: 'text', text: fixture.requestId }], metadata: { request_id: fixture.requestId } });
      if (fixture.ack) await store.agentMailbox.settle({ sessionId: fixture.sessionId, messageId: fixture.requestId });
    }
    const receipts = store.listMessageRequestStatuses('session-1');
    assert.equal(receipts.length, 4);
    assert.ok(receipts.every(receipt => receipt.status === 'queued'));
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
  { name: 'cancelled without content', fields: { status: 'cancelled', content: '' }, status: 'cancelled' },
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
    if (expectedStatus === 'cancelled') {
      assert.equal((await store.agentMailbox.get('session-1', 'mail-1')).status, 'expired');
      assert.deepEqual(await store.agentMailbox.claim({ sessionId: 'session-1', targetThreadKey: 'root', claimId: 'restore', consumerId: 'consumer' }), []);
    }
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
