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

test('useSessionMessages excludes tool observations from chat bubbles', async () => {
  setActivePinia(createPinia());
  const store = useSessionRunStore();
  const { messages } = storeToRefs(store);
  const mock = new MockAdapter(httpClient);
  mock.onGet('/api/agent/sessions/session-1/messages').reply(200, {
    data: {
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
    await sessionMessages.loadSessionMessages('session-1');

    assert.deepEqual(messages.value.map(message => message.role), ['user', 'assistant']);
    assert.equal(messages.value.some(message => message.id === 'tool-1'), false);
  } finally {
    mock.restore();
  }
});
