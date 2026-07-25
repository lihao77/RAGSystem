import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

import { useMessageRevision } from './useMessageRevision.js';
import { useSessionRunStore } from '../stores/session-run.js';
import { httpClient } from '../api/http.js';

function createDeps(overrides = {}) {
  setActivePinia(createPinia());
  const sessionRunStore = useSessionRunStore();
  const { messages, currentSessionId } = storeToRefs(sessionRunStore);
  currentSessionId.value = 'session-1';
  const sessionFilesDrawerVisible = ref(false);
  const sessionFilesDrawerTarget = ref('composer');
  const toasts = [];
  const cacheCalls = [];
  const materializeCalls = [];
  const reloadCalls = [];
  const activeRun = { active: false, assistantMsgIndex: -1, runId: null, phase: 'idle' };
  const isLoading = ref(false);

  const deps = {
    messages,
    currentSessionId,
    sessionFilesDrawerVisible,
    sessionFilesDrawerTarget,
    normalizeAttachment: (file) => (file ? { ...file, file_id: file.file_id || file.id } : null),
    showToast: (message) => toasts.push(message),
    cacheMessages: (...args) => cacheCalls.push(args),
    activeRun,
    isLoading,
    materializeAttachmentsForSend: async (attachments) => { materializeCalls.push(attachments); return attachments; },
    reloadSessionMessages: async (sessionId) => { reloadCalls.push(sessionId); },
    getCurrentSelectedLlm: () => null,
    stickToBottom: () => {},
    ...overrides,
  };

  return { deps, toasts, cacheCalls, materializeCalls, reloadCalls, activeRun, isLoading };
}

function withMock(setup, run) {
  const mock = new MockAdapter(httpClient);
  setup(mock);
  return Promise.resolve()
    .then(run)
    .finally(() => { mock.restore(); });
}

test('confirmEditAndResend 锚定旧消息并将编辑内容交给统一发送入口', async () => {
  let capturedBody = null;
  await withMock((mock) => {
    mock.onPost(/\/rollback-and-retry$/).reply((config) => {
      assert.equal(config.url, '/api/agent/sessions/session-1/rollback-and-retry');
      capturedBody = JSON.parse(config.data);
      return [200, { data: { started: true, session_id: 'session-1', request_id: 'req-new', run_id: 'run-new', task_id: 'task-new', deleted: 2 } }];
    });
  }, async () => {
    const attachment = { id: 'file-2', original_name: 'draft.txt', mime: 'text/plain', size: 12 };
    const { deps, activeRun, isLoading } = createDeps();
    deps.messages.value = [
      { role: 'user', id: 'msg-1', content: 'first' },
      { role: 'user', id: 'msg-2', content: 'draft', attachments: [attachment] },
      { role: 'assistant', id: 'msg-3', content: 'old reply', finished: true },
    ];

    const revision = useMessageRevision(deps);
    revision.startEditMessage(deps.messages.value[1], 1);
    revision.editingDraft.value = ' updated ';

    await revision.confirmEditAndResend();

    // 锚点指向被编辑消息本身（msg-2），不是前一条；透传 modify_user_message 与附件
    assert.equal(capturedBody.after_message_id, 'msg-2');
    assert.equal(capturedBody.modify_user_message, 'updated');
    assert.equal(capturedBody.attachments[0].file_id, 'file-2');

    // 本地投影与后端一致：旧锚点被删除，新 user 消息等待 message_saved 回填新 id/seq。
    assert.equal(deps.messages.value.length, 3);
    assert.equal(deps.messages.value[1].role, 'user');
    assert.equal(deps.messages.value[1].id, undefined);
    assert.equal(deps.messages.value[1].content, 'updated');
    assert.equal(deps.messages.value[1].metadata.request_id, 'req-new');
    assert.equal(deps.messages.value[1].metadata.retry_of_message_id, 'msg-2');
    assert.equal(deps.messages.value[2].role, 'assistant');
    assert.equal(activeRun.active, true);
    assert.equal(activeRun.runId, 'run-new');
    assert.equal(isLoading.value, true);
    assert.equal(revision.editingMessage.value, null);
  });
});

test('rollbackAndRetry 失败时重新加载服务端消息并提示错误', async () => {
  await withMock((mock) => {
    mock.onPost(/\/rollback-and-retry$/).reply(400, { message: '重试失败啦' });
  }, async () => {
    const serverMessages = [{ role: 'user', seq: 1, id: 'msg-server', content: 'server state' }];
    const { deps, toasts, reloadCalls } = createDeps({
      reloadSessionMessages: async (sessionId) => {
        reloadCalls.push(sessionId);
        deps.messages.value = serverMessages;
      },
    });
    const originalMessages = [
      { role: 'user', seq: 1, id: 'msg-1', content: 'question' },
      { role: 'assistant', seq: 2, id: 'msg-2', content: 'answer', finished: true },
    ];
    deps.messages.value = originalMessages;

    const revision = useMessageRevision(deps);
    await revision.rollbackAndRetry(deps.messages.value[0]);

    assert.deepEqual(deps.messages.value, serverMessages);
    assert.deepEqual(reloadCalls, ['session-1']);
    assert.deepEqual(toasts, ['重试失败啦']);
  });
});

test('confirmEditAndResend 在运行中会被拦截，不发起请求', async () => {
  let posted = false;
  await withMock((mock) => {
    mock.onPost(/\/rollback-and-retry$/).reply(() => { posted = true; return [200, { data: { started: true } }]; });
  }, async () => {
    const { deps, toasts } = createDeps();
    deps.isLoading.value = true;
    deps.messages.value = [
      { role: 'user', id: 'msg-1', content: 'first' },
      { role: 'assistant', id: 'msg-2', content: 'reply', finished: true },
    ];

    const revision = useMessageRevision(deps);
    revision.startEditMessage(deps.messages.value[0], 0);
    revision.editingDraft.value = 'edited';
    await revision.confirmEditAndResend();

    assert.equal(posted, false);
    assert.deepEqual(toasts, ['请先停止当前任务']);
  });
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
