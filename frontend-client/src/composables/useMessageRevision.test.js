import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

import { useMessageRevision } from './useMessageRevision.js';

function createDeps(overrides = {}) {
  const messages = ref([]);
  const currentSessionId = ref('session-1');
  const sessionFilesDrawerVisible = ref(false);
  const sessionFilesDrawerTarget = ref('composer');
  const inputMessage = ref('');
  const toasts = [];
  const cacheCalls = [];
  const sendCalls = [];

  const deps = {
    messages,
    currentSessionId,
    sessionFilesDrawerVisible,
    sessionFilesDrawerTarget,
    normalizeAttachment: (file) => (file ? { ...file, file_id: file.file_id || file.id } : null),
    showToast: (message) => toasts.push(message),
    cacheMessages: (...args) => cacheCalls.push(args),
    inputMessage,
    handleSend: async (payload) => { sendCalls.push(payload); },
    ...overrides,
  };

  return { deps, toasts, cacheCalls, sendCalls };
}

test('confirmEditAndResend 会用上一条消息生成 rollback body 并透传编辑载荷', async (t) => {
  const originalFetch = global.fetch;
  const fetchCalls = [];
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      json: async () => ({}),
    };
  };

  const attachment = {
    id: 'file-2',
    original_name: 'draft.txt',
    mime: 'text/plain',
    size: 12,
  };
  const { deps, sendCalls } = createDeps();
  deps.messages.value = [
    { role: 'user', id: 'msg-1', content: 'before' },
    { role: 'user', id: 'msg-2', content: 'draft', attachments: [attachment] },
  ];

  const revision = useMessageRevision(deps);
  revision.startEditMessage(deps.messages.value[1], 1);
  revision.editingDraft.value = ' updated ';

  await revision.confirmEditAndResend();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/agent/sessions/session-1/rollback');
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), { after_message_id: 'msg-1' });
  assert.deepEqual(sendCalls, [[0]].map(() => ({
    content: 'updated',
    attachments: [{ ...attachment, file_id: 'file-2' }],
    replaceFromIndex: 1,
    clearEditing: true,
  })));
});

test('rollbackAndRetry 回退失败时会恢复消息并提示错误', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => ({
    ok: false,
    json: async () => ({ message: '回退失败啦' }),
  });

  const { deps, toasts, cacheCalls } = createDeps();
  const originalMessages = [
    { role: 'user', seq: 1, content: 'question' },
    { role: 'assistant', seq: 2, content: 'answer', finished: true },
  ];
  deps.messages.value = originalMessages;

  const revision = useMessageRevision(deps);
  await revision.rollbackAndRetry(deps.messages.value[0]);

  assert.deepEqual(deps.messages.value, originalMessages);
  assert.deepEqual(cacheCalls, [['session-1', originalMessages]]);
  assert.deepEqual(toasts, ['回退失败啦']);
});

test('resetEditingState 在消息编辑场景会关闭附件抽屉并重置目标', () => {
  const { deps } = createDeps();
  deps.messages.value = [{ role: 'user', content: 'draft' }];
  deps.sessionFilesDrawerVisible.value = true;

  const revision = useMessageRevision(deps);
  revision.startEditMessage(deps.messages.value[0], 0);
  deps.sessionFilesDrawerTarget.value = 'message-edit';
  revision.resetEditingState();

  assert.equal(revision.editingMessage.value, null);
  assert.equal(revision.editingDraft.value, '');
  assert.deepEqual(revision.editingAttachmentsDraft.value, []);
  assert.equal(deps.sessionFilesDrawerVisible.value, false);
  assert.equal(deps.sessionFilesDrawerTarget.value, 'composer');
});
