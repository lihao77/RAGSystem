import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

import { findRetryMessage, useMessageListView } from './useMessageListView.js';

test('同一 run 的 followup 作为独立消息边界出现在主消息列表', () => {
  const original = { role: 'user', content: '第一条', seq: 1, metadata: {} };
  const second = followup('第二条', 2);
  const third = followup('第三条', 3);
  const assistant = {
    role: 'assistant',
    content: '回复',
    seq: 4,
    metadata: { run_id: 'run-1' },
  };
  const messages = ref([original, second, third, assistant]);
  const view = useMessageListView({ messages, showToast: () => {} });

  assert.deepEqual(
    view.visibleMessages.value.map(message => message.content),
    ['第一条', '第二条', '第三条', '回复'],
  );
});

test('历史 followup 在实际消费 run 中仍作为可见消息边界', () => {
  const injection = followup('后来消费', 2);
  injection.metadata.run_id = 'enqueue-run';
  injection.metadata.consumed_by_run_id = 'consumer-run';
  const messages = ref([injection]);
  const view = useMessageListView({ messages, showToast: () => {} });

  assert.deepEqual(view.visibleMessages.value, [injection]);
});

test('未持久化的 followup 不写入 messages，因此不污染主消息列表', () => {
  const messages = ref([
    { role: 'user', content: '第一条', metadata: {} },
    { role: 'assistant', content: '回复中', metadata: { run_id: 'run-1' } },
  ]);
  const view = useMessageListView({ messages, showToast: () => {} });

  assert.deepEqual(
    view.visibleMessages.value.map(message => message.content),
    ['第一条', '回复中'],
  );
});

test('agent message is a retry barrier instead of falling back to an older human turn', () => {
  const human = { role: 'user', id: 'human-1', content: '开始任务', metadata: {} };
  const agentMessage = { role: 'user', id: 'agent-1', content: '子任务结果', metadata: { agent_message: true } };
  const items = [
    human,
    { role: 'assistant', id: 'assistant-1', content: '处理中' },
    agentMessage,
    { role: 'assistant', id: 'assistant-2', content: '继续处理完成' },
  ];

  assert.equal(findRetryMessage(items, 3, () => true), null);
  assert.equal(findRetryMessage(items.slice(0, 2), 1, message => message === human), human);
  assert.equal(findRetryMessage(items.slice(0, 2), 1, () => false), null);
});

function followup(content, seq) {
  return {
    role: 'user',
    content,
    seq,
    metadata: {
      execution_kind: 'session_followup',
      source: 'running_session',
      run_id: 'run-1',
    },
  };
}
