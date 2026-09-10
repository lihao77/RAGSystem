import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSessionTeamRevision } from '@ragsystem/backend-core/contracts/session/session.js';
import { AgentSessionApplication } from '@ragsystem/backend-core/services/sessions/index.js';
import { LocalAgentSessionRepository } from '../dist/adapters/local/local-agent-session-repository.js';
import { createConversationStore } from '../dist/adapters/local/sqlite/conversation-store/index.js';

function createSession(store, sessionId = 'session-1') {
  const agents = { assistant: { agent_name: 'assistant' } };
  store.createSession({
    tenantId: 'tnt_test', sessionId, ownerUserId: 'usr_test', visibility: 'private',
    originType: 'direct', originId: null, originChannel: 'web', workspaceId: null,
    metadata: {}, teamSnapshot: {
      team_name: 'default', team_revision: computeSessionTeamRevision(agents),
      entry_agent_name: 'assistant', agents,
    },
  });
}

function addMessage(store, id, metadata, overrides = {}) {
  return store.addMessage({
    sessionId: 'session-1', messageId: id, role: 'user', contentParts: [], metadata,
    threadKey: 'root', ...overrides,
  });
}

test('SQLite filters execution rows before pagination with legacy run ownership and thread isolation', async () => {
  const store = createConversationStore({ dbPath: ':memory:', dataRoot: process.cwd() });
  try {
    createSession(store);
    createSession(store, 'session-2');
    addMessage(store, 'legacy-run', { run_id: 'run-1' });
    addMessage(store, 'legacy-consumed', { consumed_by_run_id: 'run-1' });
    addMessage(store, 'null-consumed', { consumed_by_run_id: null, run_id: 'run-1' });
    addMessage(store, 'consumed-precedence', { consumed_by_run_id: 'run-1', run_id: 'other-run' });
    addMessage(store, 'different-owner', { consumed_by_run_id: 'other-run', run_id: 'run-1' });
    addMessage(store, 'empty-consumed', { consumed_by_run_id: '', run_id: 'run-1' });
    addMessage(store, 'numeric-consumed', { consumed_by_run_id: 123, run_id: 'run-1' });
    addMessage(store, 'object-consumed', { consumed_by_run_id: {}, run_id: 'run-1' });
    addMessage(store, 'other-thread', { run_id: 'run-1' }, { threadKey: 'child:child-1', childAgentId: 'child-1' });
    addMessage(store, 'other-session', { run_id: 'run-1' }, { sessionId: 'session-2' });
    const repository = new LocalAgentSessionRepository(store);
    const recent = await repository.listMessages('session-1', 2, 0, 'root', ['run-1']);
    const older = await repository.listMessages('session-1', 2, 2, 'root', ['run-1']);
    assert.deepEqual(recent.items.map(row => row.id), ['null-consumed', 'consumed-precedence']);
    assert.equal(recent.total, 4);
    assert.equal(recent.has_more, true);
    assert.deepEqual(older.items.map(row => row.id), ['legacy-run', 'legacy-consumed']);
    assert.equal(older.has_more, false);
    assert.equal((await repository.listMessages('session-1', 20, 0, 'root')).total, 8);
    assert.equal((await repository.listMessages('session-1', 20, 0, 'root', [])).total, 0);
    assert.equal((await repository.listMessages('session-1', 20, 0, 'root', ['123', '{}'])).total, 0);
  } finally {
    store.close();
  }
});

test('empty execution candidates do not load unrelated history pages', async () => {
  const store = createConversationStore({ dbPath: ':memory:', dataRoot: process.cwd() });
  try {
    createSession(store);
    store.runInTransaction(tx => {
      for (let index = 0; index < 1001; index += 1) {
        addMessage(tx, `old-step-${index}`, { run_id: 'old-run', hidden: true }, {
          role: 'assistant', contentParts: [{ type: 'thinking', text: '历史执行内容', complete: true }],
        });
      }
      addMessage(tx, 'current-user', { consumed_by_run_id: 'current-run' });
    });
    const repository = new LocalAgentSessionRepository(store);
    const loadPage = repository.listMessages.bind(repository);
    const reads = [];
    repository.listMessages = async (...args) => {
      const page = await loadPage(...args);
      reads.push({ args, ids: page.items.map(row => row.id) });
      return page;
    };
    const history = await new AgentSessionApplication(repository).listMessages({ sessionId: 'session-1', limit: 1 });
    assert.deepEqual(history.items.map(row => [row.id, row.has_execution]), [['current-user', false]]);
    assert.deepEqual(reads, [{ args: ['session-1', 1000, 0, 'root', ['current-run']], ids: ['current-user'] }]);
  } finally {
    store.close();
  }
});
