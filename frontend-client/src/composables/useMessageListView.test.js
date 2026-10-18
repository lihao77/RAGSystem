import test from 'node:test';
import assert from 'node:assert/strict';
import { computed, ref } from 'vue';

import { buildRetryMessages, useMessageListView } from './useMessageListView.js';

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

  assert.equal(buildRetryMessages(items, () => true)[3], null);
  assert.equal(buildRetryMessages(items.slice(0, 2), message => message === human)[1], human);
  assert.equal(buildRetryMessages(items.slice(0, 2), () => false)[1], null);
});

test('重试关联遵循最近用户边界，不能越过不可编辑输入', () => {
  const first = { role: 'user', id: 'first' };
  const denied = { role: 'user', id: 'denied' };
  const last = { role: 'user', id: 'last' };
  const assistant = { role: 'assistant' };
  assert.deepEqual(buildRetryMessages([assistant, first, assistant, { role: 'system' }, denied, assistant, last, assistant],
    message => message !== denied), [null, null, first, first, first, null, null, last]);
  assert.deepEqual(buildRetryMessages(null), []);
});

test('正文流式更新复用关联索引，追加、删除、权限和 Agent 消息变化重新计算', () => {
  const messages = ref([{ role: 'user', id: 'one', metadata: {} }, { role: 'assistant', content: '开始' }]);
  const allowed = ref(true);
  const index = computed(() => buildRetryMessages(messages.value, () => allowed.value));
  const initial = index.value;
  messages.value[1].content += '追加';
  assert.equal(index.value, initial);
  messages.value.push({ role: 'assistant' });
  assert.equal(index.value[2], messages.value[0]);
  allowed.value = false;
  assert.deepEqual(index.value, [null, null, null]);
  allowed.value = true;
  messages.value[0].metadata.agent_message = true;
  assert.deepEqual(index.value, [null, null, null]);
  messages.value.splice(0, 1);
  assert.deepEqual(index.value, [null, null]);
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

test('压缩摘要消息不进列表，原始对话完整渲染', () => {
  const old1 = { role: 'user', content: '旧消息1', seq: 1, metadata: {} };
  const old2 = { role: 'assistant', content: '旧回复', seq: 2, metadata: {} };
  const summary = {
    role: 'assistant',
    content: '[历史摘要]',
    seq: 3,
    metadata: { msg_type: 'context_compression_summary', replaces_up_to_seq: 2 },
  };
  const recent = { role: 'user', content: '压缩后的新消息', seq: 4, metadata: {} };
  const messages = ref([old1, old2, summary, recent]);
  const view = useMessageListView({ messages, showToast: () => {} });

  // 压缩只影响发给 LLM 的上下文：被"替换"的旧消息仍然渲染，摘要消息本身隐藏。
  assert.deepEqual(
    view.visibleMessages.value.map(message => message.content),
    ['旧消息1', '旧回复', '压缩后的新消息'],
  );
});

test('刷新后 maintenance(compact) 租约派生补挂"正在压缩…"横线', () => {
  const messages = ref([{ role: 'user', content: '/compact', seq: 1, metadata: {} }]);
  const sessionRuntime = ref(null);
  const view = useMessageListView({ messages, showToast: () => {}, sessionRuntime });

  // 无租约：无横线。
  assert.deepEqual(view.visibleMessages.value.map(m => m.content), ['/compact']);

  // 刷新恢复：租约在（快照持久事实），瞬态横线丢失后由视图派生补挂。
  sessionRuntime.value = { state: 'maintenance', maintenance: { kind: 'compact', expires_at: '2099-01-01T00:00:00Z' } };
  const withDerived = view.visibleMessages.value;
  assert.deepEqual(withDerived.map(m => m.content), ['/compact', '正在压缩…']);
  assert.equal(withDerived[1].metadata.msg_type, 'context_compression_pending');

  // 派生对象引用稳定：computed 重算不换 key、不重挂动画。
  assert.equal(view.visibleMessages.value[1], withDerived[1]);

  // 租约结束（完成/释放/过期）：横线自动消失。
  sessionRuntime.value = { state: 'idle', maintenance: null };
  assert.deepEqual(view.visibleMessages.value.map(m => m.content), ['/compact']);
});

test('maintenance 为 rollback 租约时不挂压缩横线', () => {
  const messages = ref([{ role: 'user', content: 'hi', seq: 1, metadata: {} }]);
  const sessionRuntime = ref({ state: 'maintenance', maintenance: { kind: 'rollback', expires_at: '2099-01-01T00:00:00Z' } });
  const view = useMessageListView({ messages, showToast: () => {}, sessionRuntime });

  assert.deepEqual(view.visibleMessages.value.map(m => m.content), ['hi']);
});

test('帧驱动瞬态横线已在列表时，派生逻辑不重复挂', () => {
  const transient = {
    role: 'system',
    content: '正在压缩…',
    content_parts: [{ type: 'text', text: '正在压缩…' }],
    metadata: { msg_type: 'context_compression_pending' },
  };
  const messages = ref([
    { role: 'user', content: '/compact', seq: 1, metadata: {} },
    transient,
  ]);
  const sessionRuntime = ref({ state: 'maintenance', maintenance: { kind: 'compact', expires_at: '2099-01-01T00:00:00Z' } });
  const view = useMessageListView({ messages, showToast: () => {}, sessionRuntime });

  assert.equal(view.visibleMessages.value.length, 2);
  // reactive 代理包住元素，引用比较不可靠；断言只有一条且是列表内那条（非派生对象）。
  assert.equal(view.visibleMessages.value.filter(
    m => m.metadata?.msg_type === 'context_compression_pending',
  ).length, 1);
});
