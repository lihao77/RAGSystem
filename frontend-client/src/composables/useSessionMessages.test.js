import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

import { useSessionMessages } from './useSessionMessages.js';
import { useSessionRunStore } from '../stores/session-run.js';

function createDeps(overrides = {}) {
  return {
    normalizeAssistantExecutionState: item => item,
    createAssistantMessageFromHistory: item => ({
      role: 'assistant',
      id: item.id,
      seq: item.seq,
      content: item.content,
      metadata: item.metadata || {},
      finished: true,
    }),
    normalizeAttachment: item => item,
    scrollToBottom: async () => {},
    waitForScrollLayout: async () => {},
    focusInput: () => {},
    loadContextSnapshot: async () => {},
    showToast: () => {},
    invalidateActiveStream: () => {},
    ...overrides,
  };
}

test('useSessionMessages excludes tool observations from chat bubbles', async () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  const { currentSessionId, messages } = storeToRefs(store);
  currentSessionId.value = 'session-1';
  const chatSdkClient = { async listMessages() { return {
    data: {
      outbox_watermark: 17,
      items: [
        { id: 'user-1', seq: 1, role: 'user', content: '请执行工具', metadata: {} },
        {
          id: 'tool-1',
          seq: 2,
          role: 'tool',
          content: '工具执行被中断',
          metadata: { msg_type: 'observation', interrupted: true },
        },
        {
          id: 'assistant-1',
          seq: 3,
          role: 'assistant',
          content: '本次运行已中断，未生成最终答案。原因：用户主动停止运行',
          metadata: { msg_type: 'run_terminal', terminal_status: 'interrupted', terminal_reason: 'session_stopped' },
        },
      ],
    },
  }; } };

    const sessionMessages = useSessionMessages(createDeps({ chatSdkClient }));
    const watermark = await sessionMessages.loadSessionMessages('session-1');

    assert.deepEqual(messages.value.map(message => message.role), ['user', 'assistant']);
    assert.equal(messages.value.some(message => message.id === 'tool-1'), false);
    assert.equal(messages.value[1].content.includes('用户主动停止运行'), true);
    assert.equal(watermark, 17);
});

test('agent mailbox messages are visible with clean display content while other hidden messages stay hidden', async () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  const { currentSessionId, messages } = storeToRefs(store);
  currentSessionId.value = 'session-1';
  store.setSelectedParticipant('child-1');
  const chatSdkClient = { async listMessages() { return {
    data: {
      items: [
        {
          id: 'agent-message-1',
          seq: 1,
          role: 'user',
          content: '[agent-message kind=request id=agent-message-1]\n停止工具调用\n[/agent-message]',
          content_parts: [{ type: 'text', text: '[agent-message kind=request id=agent-message-1]\n停止工具调用\n[/agent-message]' }],
          metadata: { agent_message: true, visible_to_user: false, mailbox_kind: 'request' },
        },
        { id: 'internal-1', seq: 2, role: 'user', content: 'internal', metadata: { visible_to_user: false } },
      ],
    },
  }; } };

  const sessionMessages = useSessionMessages(createDeps({ chatSdkClient }));
  await sessionMessages.loadSessionMessages('session-1', { participantId: 'child-1' });

  assert.equal(messages.value.length, 1);
  assert.equal(messages.value[0].content, '停止工具调用');
  assert.equal(messages.value[0].metadata.agent_message, true);
  assert.equal(messages.value[0].metadata.agent_message_display_content, '停止工具调用');
});

test('active run 消息重载完成后重新请求历史执行快照', async () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  const { currentSessionId } = storeToRefs(store);
  currentSessionId.value = 'session-1';
  const calls = [];
  const chatSdkClient = { async listMessages() { return {
    data: { items: [{ id: 'user-1', seq: 1, role: 'user', content: '继续', metadata: {} }], outbox_watermark: 19 },
  }; } };

    const sessionMessages = useSessionMessages({
      ...createDeps(),
      chatSdkClient,
      shouldReplayActiveRun: () => true,
      replayActiveRun: (sessionId) => { calls.push(sessionId); },
    });
    const watermark = await sessionMessages.loadSessionMessages('session-1');

    assert.equal(watermark, 19);
    assert.deepEqual(calls, ['session-1']);
});

test('a late response from the previous session cannot overwrite current messages', async () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  const { currentSessionId, messages } = storeToRefs(store);
  const pending = new Map();
  const chatSdkClient = {
    listMessages(sessionId) {
      return new Promise((resolve) => { pending.set(sessionId, resolve); });
    },
  };

    const sessionMessages = useSessionMessages(createDeps({ chatSdkClient }));
    currentSessionId.value = 'session-a';
    const loadA = sessionMessages.loadSessionMessages('session-a');
    currentSessionId.value = 'session-b';
    const loadB = sessionMessages.loadSessionMessages('session-b');

    const resolveB = pending.get('session-b');
    resolveB({
      data: { items: [{ id: 'b-1', seq: 1, role: 'user', content: 'session B', metadata: {} }], outbox_watermark: 8 },
    });
    await loadB;
    const resolveA = pending.get('session-a');
    resolveA({
      data: { items: [{ id: 'a-1', seq: 1, role: 'user', content: 'session A', metadata: {} }], outbox_watermark: 4 },
    });
    await loadA;

    assert.deepEqual(messages.value.map(message => message.id), ['b-1']);
    assert.equal(sessionMessages.messageCache.value.has('session-a'), false);
});
