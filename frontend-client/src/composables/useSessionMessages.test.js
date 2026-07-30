import assert from 'node:assert/strict';
import test from 'node:test';
import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

import { useSessionMessages } from './useSessionMessages.js';
import { httpClient } from '../api/http.js';
import { useSessionRunStore } from '../stores/session-run.js';

function createDeps() {
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
  };
}

async function waitForPending(pending, key) {
  for (let attempt = 0; attempt < 20 && !pending.has(key); attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  return pending.get(key);
}

test('useSessionMessages excludes tool observations from chat bubbles', async () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  const { currentSessionId, messages } = storeToRefs(store);
  currentSessionId.value = 'session-1';
  const mock = new MockAdapter(httpClient);
  mock.onGet('/api/agent/sessions/session-1/messages').reply(200, {
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
        { id: 'assistant-1', seq: 3, role: 'assistant', content: '', metadata: { interrupted: true } },
      ],
    },
  });

  try {
    const sessionMessages = useSessionMessages(createDeps());
    const watermark = await sessionMessages.loadSessionMessages('session-1');

    assert.deepEqual(messages.value.map(message => message.role), ['user', 'assistant']);
    assert.equal(messages.value.some(message => message.id === 'tool-1'), false);
    assert.equal(watermark, 17);
  } finally {
    mock.restore();
  }
});

test('active run 消息重载完成后重新请求历史执行快照', async () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  const { currentSessionId } = storeToRefs(store);
  currentSessionId.value = 'session-1';
  const calls = [];
  const mock = new MockAdapter(httpClient);
  mock.onGet('/api/agent/sessions/session-1/messages').reply(200, {
    data: { items: [{ id: 'user-1', seq: 1, role: 'user', content: '继续', metadata: {} }], outbox_watermark: 19 },
  });

  try {
    const sessionMessages = useSessionMessages({
      ...createDeps(),
      shouldReplayActiveRun: () => true,
      replayActiveRun: (sessionId) => { calls.push(sessionId); },
    });
    const watermark = await sessionMessages.loadSessionMessages('session-1');

    assert.equal(watermark, 19);
    assert.deepEqual(calls, ['session-1']);
  } finally {
    mock.restore();
  }
});

test('a late response from the previous session cannot overwrite current messages', async () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  const { currentSessionId, messages } = storeToRefs(store);
  const mock = new MockAdapter(httpClient);
  const pending = new Map();
  mock.onGet(/\/api\/agent\/sessions\/[^/]+\/messages/).reply(config => new Promise((resolve) => {
    pending.set(config.url, resolve);
  }));

  try {
    const sessionMessages = useSessionMessages(createDeps());
    currentSessionId.value = 'session-a';
    const loadA = sessionMessages.loadSessionMessages('session-a');
    currentSessionId.value = 'session-b';
    const loadB = sessionMessages.loadSessionMessages('session-b');

    const resolveB = await waitForPending(pending, '/api/agent/sessions/session-b/messages');
    resolveB([200, {
      data: { items: [{ id: 'b-1', seq: 1, role: 'user', content: 'session B', metadata: {} }], outbox_watermark: 8 },
    }]);
    await loadB;
    const resolveA = await waitForPending(pending, '/api/agent/sessions/session-a/messages');
    resolveA([200, {
      data: { items: [{ id: 'a-1', seq: 1, role: 'user', content: 'session A', metadata: {} }], outbox_watermark: 4 },
    }]);
    await loadA;

    assert.deepEqual(messages.value.map(message => message.id), ['b-1']);
    assert.equal(sessionMessages.messageCache.value.has('session-a'), false);
  } finally {
    mock.restore();
  }
});
