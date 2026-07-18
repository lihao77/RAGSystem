import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

import { useMessageListView } from './useMessageListView.js';

test('同一 run 的 followup 顶层可见并稳定排在 assistant 后', () => {
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
    ['第一条', '回复', '第二条', '第三条'],
  );
  assert.deepEqual(view.injectionsByRunId.value['run-1'], [second, third]);
});

test('尚未取得 run id 的 optimistic followup 保持追加位置且不会消失', () => {
  const messages = ref([
    { role: 'user', content: '第一条', metadata: {} },
    { role: 'assistant', content: '回复中', metadata: { run_id: 'run-1' } },
    {
      role: 'user',
      content: '第二条',
      metadata: { source: 'running_session', persistence_status: 'pending' },
    },
  ]);
  const view = useMessageListView({ messages, showToast: () => {} });

  assert.deepEqual(
    view.visibleMessages.value.map(message => message.content),
    ['第一条', '回复中', '第二条'],
  );
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
