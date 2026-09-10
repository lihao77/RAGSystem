import test from 'node:test';
import assert from 'node:assert/strict';
import { SaaSSessionApplication } from '../dist/adapters/saas/application/session/saas-session-application.js';

test('SaaS history exposes only the input boundary owning execution steps', async () => {
  const users = ['u1', 'u2', 'u3'].map((id, index) => ({
    id, seq: index + 1, session_id: 'session-1', role: 'user',
    thread_key: 'root', child_agent_id: null, content_parts: [],
    metadata: { run_id: 'run-1', consumed_by_run_id: 'run-1' },
  }));
  const final = { ...users[0], id: 'final', seq: 5, role: 'assistant', content_parts: [{ type: 'text', text: '完成' }] };
  const step = { ...final, id: 'step', seq: 4,
    metadata: { run_id: 'run-1', boundary_message_id: 'u2', hidden: true },
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }],
  };
  const rows = [...users, step, final];
  const sessions = new SaaSSessionApplication('tenant-1', {
    async getSession() { return { tenant_id: 'tenant-1' }; },
    async listVisibleMessagesSnapshot() { return { items: [...users, final], has_more: false }; },
    async listMessages(sessionId, limit, _offset, threadKey, runIds) {
      assert.equal(sessionId, 'session-1');
      assert.equal(threadKey, 'root');
      if (limit === 1000) assert.deepEqual(runIds, ['run-1']);
      return { items: rows, has_more: false };
    },
    async getMessageById(_sessionId, messageId) { return rows.find(row => row.id === messageId); },
  }, {});
  const history = await sessions.listMessages({ sessionId: 'session-1' });
  assert.deepEqual(history.items.map(row => [row.id, row.has_execution]), [
    ['u1', false], ['u2', true], ['u3', false], ['final', false],
  ]);
  const execution = await sessions.listMessageExecution({ sessionId: 'session-1', messageId: 'u2' });
  assert.equal(execution.items.some(event => event.type === 'tool_call'), true);
});
