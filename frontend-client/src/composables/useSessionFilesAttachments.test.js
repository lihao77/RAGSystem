import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

import { useSessionFilesAttachments } from './useSessionFilesAttachments.js';

function createDeps(overrides = {}) {
  setActivePinia(createPinia());
  const sessionFilesDrawerVisible = ref(false);
  const sessionFilesDrawerTarget = ref('composer');
  const currentSessionId = ref('session-1');
  const editingAttachmentsDraft = ref([]);
  const toasts = [];
  const deps = {
    currentSessionId,
    sessionFilesDrawerVisible,
    sessionFilesDrawerTarget,
    getEditingAttachmentsDraft: () => editingAttachmentsDraft.value,
    setEditingAttachmentsDraft: (value) => { editingAttachmentsDraft.value = value; },
    ensureSession: async () => 'session-1',
    showToast: (...args) => toasts.push(args),
    ...overrides,
  };
  return { deps, toasts, editingAttachmentsDraft };
}

test('handleSessionFileSelect 只加入前端待发送附件，不立即创建 session', async () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:local-preview';
  URL.revokeObjectURL = () => {};

  let ensureSessionCalls = 0;
  const { deps } = createDeps({
    ensureSession: async () => {
      ensureSessionCalls += 1;
      return 'session-1';
    },
  });

  const state = useSessionFilesAttachments(deps);
  const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
  await state.handleSessionFileSelect([file]);

  assert.equal(ensureSessionCalls, 0);
  assert.equal(state.pendingAttachments.value.length, 1);
  assert.equal(state.pendingAttachments.value[0].source, 'local');
  assert.equal(state.pendingAttachments.value[0].original_name, 'note.txt');

  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

test('handleSessionFileSelect 只就地加入待发送附件，不弹出附件抽屉', async () => {
  const { deps } = createDeps();
  const state = useSessionFilesAttachments(deps);

  await state.handleSessionFileSelect([new File(['hello'], 'note.txt', { type: 'text/plain' })]);

  assert.equal(state.pendingAttachments.value.length, 1);
  // 粘贴/拖放发生在输入中途：附件卡已内联出现在输入框里，抽屉只能由加号按钮显式打开
  assert.equal(deps.sessionFilesDrawerVisible.value, false);
});

test('materializeAttachmentsForSend 会批量上传本地附件并保持顺序', async () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = (file) => `blob:${file.name}`;
  URL.revokeObjectURL = () => {};

  const calls = [];
  const chatSdkClient = {
    async uploadFiles(sessionId, files) {
      calls.push(['uploadFiles', sessionId, files]);
      return {
      files: [
        { id: 'file-1', original_name: 'a.png', stored_name: 'stored-a.png', mime: 'image/png', size: 1 },
        { id: 'file-2', original_name: 'b.txt', stored_name: 'stored-b.txt', mime: 'text/plain', size: 1 },
      ],
      };
    },
    async listFiles(sessionId) {
      calls.push(['listFiles', sessionId]);
      return { files: [] };
    },
  };

  try {
    const { deps } = createDeps({ chatSdkClient });
    const state = useSessionFilesAttachments(deps);
    await state.handleSessionFileSelect([
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.txt', { type: 'text/plain' }),
    ]);

    const result = await state.materializeAttachmentsForSend(state.pendingAttachments.value.slice(), 'session-1');

    assert.deepEqual(result.map(item => item.file_id), ['file-1', 'file-2']);
    assert.deepEqual(result.map(item => item.source), ['session', 'session']);
    assert.equal(calls[0][0], 'uploadFiles');
    assert.equal(calls[0][1], 'session-1');
    assert.deepEqual(calls[0][2].map(file => file.name), ['a.png', 'b.txt']);
    assert.deepEqual(calls[1], ['listFiles', 'session-1']);
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

test('Electron 普通附件链接原文件，图片和无磁盘路径附件上传，混合引用保持顺序', async () => {
  const calls = [];
  const { deps } = createDeps({
    getPathForFile(file) {
      calls.push(['path', file.name]);
      return file.name === '报告.pdf' ? 'D:\\资料\\报告.pdf' : '';
    },
    chatSdkClient: {
      async linkLocalFile(sessionId, input) {
        calls.push(['link', sessionId, input]);
        return { file: { id: 'linked-pdf', original_name: input.original_name, mime: input.mime, storage_kind: 'linked_local', local_path: input.path } };
      },
      async uploadFiles(sessionId, files) {
        calls.push(['upload', sessionId, files.map(file => file.name)]);
        return { files: files.map(file => ({ id: `uploaded-${file.name}`, original_name: file.name, mime: file.type })) };
      },
      async listFiles() { return { files: [] }; },
    },
  });
  const state = useSessionFilesAttachments(deps);
  await state.handleSessionFileSelect([
    new File(['pdf'], '报告.pdf', { type: 'application/pdf' }),
    new File(['image'], 'photo.png', { type: 'image/png' }),
    new File(['generated'], 'clipboard.txt', { type: 'text/plain' }),
    new File(['image'], 'unknown-mime.webp'),
  ]);
  assert.deepEqual(calls, [], 'selection must not upload or register attachments');
  const existing = { file_id: 'existing-1', mime: 'text/plain' };
  const pending = state.pendingAttachments.value;
  const result = await state.materializeAttachmentsForSend([pending[0], existing, ...pending.slice(1)], 'session-1');
  assert.deepEqual(result.map(item => item.file_id), [
    'linked-pdf', 'existing-1', 'uploaded-photo.png', 'uploaded-clipboard.txt', 'uploaded-unknown-mime.webp',
  ]);
  assert.equal(result[0].local_path, 'D:\\资料\\报告.pdf');
  assert.deepEqual(calls, [
    ['path', '报告.pdf'],
    ['link', 'session-1', { path: 'D:\\资料\\报告.pdf', original_name: '报告.pdf', mime: 'application/pdf' }],
    ['path', 'clipboard.txt'],
    ['upload', 'session-1', ['photo.png', 'clipboard.txt', 'unknown-mime.webp']],
  ]);
  assert.equal(state.uploadingSessionFiles.value, false);
});

test('Electron 消息编辑使用链接登记普通文件，重用已登记附件不再次链接', async () => {
  const calls = [];
  const { deps, editingAttachmentsDraft } = createDeps({
    getPathForFile: () => 'D:\\资料\\note.txt',
    chatSdkClient: {
      async linkLocalFile(sessionId, input) {
        calls.push([sessionId, input]);
        return { file: { id: 'linked-note', mime: input.mime, original_name: input.original_name } };
      },
      async listFiles() { return { files: [] }; },
    },
  });
  deps.sessionFilesDrawerTarget.value = 'message-edit';
  const state = useSessionFilesAttachments(deps);
  await state.handleSessionFileSelect([new File(['hello'], 'note.txt', { type: 'text/plain' })]);
  assert.equal(state.pendingAttachments.value.length, 0);
  const linked = await state.materializeAttachmentsForSend(editingAttachmentsDraft.value, 'session-1');
  assert.equal(calls.length, 1);
  assert.deepEqual(await state.materializeAttachmentsForSend(linked, 'session-1'), linked);
  assert.equal(calls.length, 1);
});

test('本地链接失败会阻止发送，不静默上传副本', async () => {
  let uploads = 0;
  const { deps } = createDeps({
    getPathForFile: () => 'D:\\missing.txt',
    chatSdkClient: {
      async linkLocalFile() { throw new Error('原文件不存在'); },
      async uploadFiles() { uploads += 1; },
    },
  });
  const state = useSessionFilesAttachments(deps);
  await state.handleSessionFileSelect([new File(['hello'], 'missing.txt')]);
  await assert.rejects(state.materializeAttachmentsForSend(state.pendingAttachments.value, 'session-1'), /原文件不存在/);
  assert.equal(uploads, 0);
  assert.equal(state.pendingAttachments.value.length, 1);
  assert.equal(state.uploadingSessionFiles.value, false);
});

test('Electron TIFF 附件引用原文件，不走图片上传或预览', async () => {
  const linkedPaths = [];
  const { deps } = createDeps({
    getPathForFile: file => `D:\\资料\\${file.name}`,
    chatSdkClient: {
      async linkLocalFile(sessionId, input) {
        linkedPaths.push(input.path);
        return { file: { id: input.original_name, original_name: input.original_name, mime: input.mime, storage_kind: 'linked_local' } };
      },
      async uploadFiles() { assert.fail('TIFF must not use the image upload path'); },
      async listFiles() { return { files: [] }; },
    },
  });
  const state = useSessionFilesAttachments(deps);
  await state.handleSessionFileSelect([new File(['tiff'], 'scan.tif', { type: 'image/tiff' })]);
  assert.equal(state.pendingAttachments.value[0].preview_url, '');
  const result = await state.materializeAttachmentsForSend(state.pendingAttachments.value, 'session-1');
  assert.deepEqual(linkedPaths, ['D:\\资料\\scan.tif']);
  assert.equal(result[0].kind, 'file');
});

test('部分链接失败后重试复用已成功的引用，保持原附件顺序', async () => {
  const registered = [];
  let missingSecondFile = true;
  const { deps } = createDeps({
    getPathForFile: file => `D:\\${file.name}`,
    chatSdkClient: {
      async linkLocalFile(sessionId, input) {
        if (input.original_name === 'b.txt' && missingSecondFile) throw new Error('b.txt 不存在');
        const file = { id: `linked-${registered.length}`, original_name: input.original_name, mime: input.mime };
        registered.push(file);
        return { file };
      },
      async listFiles() { return { files: registered }; },
    },
  });
  const state = useSessionFilesAttachments(deps);
  await state.handleSessionFileSelect([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);
  await assert.rejects(state.materializeAttachmentsForSend(state.pendingAttachments.value, 'session-1'), /b.txt 不存在/);
  assert.deepEqual(state.pendingAttachments.value.map(file => file.source), ['local', 'local']);
  missingSecondFile = false;
  const result = await state.materializeAttachmentsForSend(state.pendingAttachments.value, 'session-1');
  assert.deepEqual(registered.map(file => file.original_name), ['a.txt', 'b.txt']);
  assert.deepEqual(result.map(file => file.file_id), ['linked-0', 'linked-1']);
});

test('链接后图片上传失败保留预览，重试不重复链接并在整体成功后释放预览', async () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const revoked = [];
  URL.createObjectURL = file => `blob:${file.name}`;
  URL.revokeObjectURL = url => revoked.push(url);
  let links = 0;
  let uploadFails = true;
  const { deps } = createDeps({
    getPathForFile: file => `D:\\${file.name}`,
    chatSdkClient: {
      async linkLocalFile(sessionId, input) {
        links += 1;
        return { file: { id: 'linked-note', original_name: input.original_name, mime: input.mime } };
      },
      async uploadFiles() {
        if (uploadFails) throw new Error('图片上传失败');
        return { files: [{ id: 'uploaded-image', original_name: 'photo.png', mime: 'image/png' }] };
      },
      async listFiles() { return { files: [] }; },
    },
  });
  try {
    const state = useSessionFilesAttachments(deps);
    await state.handleSessionFileSelect([new File(['a'], 'a.txt'), new File(['image'], 'photo.png', { type: 'image/png' })]);
    await assert.rejects(state.materializeAttachmentsForSend(state.pendingAttachments.value, 'session-1'), /图片上传失败/);
    assert.equal(state.pendingAttachments.value[1].preview_url, 'blob:photo.png');
    assert.deepEqual(revoked, []);
    uploadFails = false;
    const result = await state.materializeAttachmentsForSend(state.pendingAttachments.value, 'session-1');
    assert.equal(links, 1);
    assert.deepEqual(result.map(file => file.file_id), ['linked-note', 'uploaded-image']);
    assert.deepEqual(revoked, ['blob:photo.png']);
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

test('部分成功缓存隔离会话，移除附件时清理缓存', async () => {
  const registered = [];
  const { deps } = createDeps({
    getPathForFile: file => `D:\\${file.name}`,
    chatSdkClient: {
      async linkLocalFile(sessionId, input) {
        if (input.original_name === 'missing.txt') throw new Error('文件不存在');
        const file = { id: `${sessionId}-${registered.length}`, original_name: input.original_name, mime: input.mime };
        registered.push({ sessionId, file });
        return { file };
      },
      async listFiles() { return { files: [] }; },
    },
  });
  const state = useSessionFilesAttachments(deps);
  await state.handleSessionFileSelect([new File(['a'], 'a.txt'), new File(['b'], 'missing.txt')]);
  const draft = state.pendingAttachments.value.slice();
  await assert.rejects(state.materializeAttachmentsForSend(draft, 'session-1'), /文件不存在/);
  await assert.rejects(state.materializeAttachmentsForSend(draft, 'session-2'), /文件不存在/);
  await assert.rejects(state.materializeAttachmentsForSend(draft, 'session-1'), /文件不存在/);
  assert.deepEqual(registered.map(entry => entry.sessionId), ['session-1', 'session-2']);
  state.removePendingAttachment(draft[0]);
  const result = await state.materializeAttachmentsForSend([draft[0]], 'session-1');
  assert.equal(registered.length, 3, 'removed attachment must not retain cached registrations');
  assert.equal(result[0].file_id, 'session-1-2');
});

test('部分失败后删除已登记文件会失效缓存，删除中切会话仍清理原会话缓存', async () => {
  const registered = [];
  let missingSecondFile = true;
  let completeDelete;
  const deleteFinished = new Promise(resolve => { completeDelete = resolve; });
  const calls = [];
  const { deps } = createDeps({
    getPathForFile: file => `D:\\${file.name}`,
    chatSdkClient: {
      async linkLocalFile(sessionId, input) {
        if (input.original_name === 'b.txt' && missingSecondFile) throw new Error('b.txt 不存在');
        const file = { id: `linked-${registered.length}`, original_name: input.original_name, mime: input.mime };
        registered.push(file);
        return { file };
      },
      async listFiles() { return { files: registered.slice() }; },
      async deleteFile(sessionId, id) {
        calls.push([sessionId, id]);
        await deleteFinished;
      },
    },
  });
  const state = useSessionFilesAttachments(deps);
  await state.handleSessionFileSelect([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);
  await assert.rejects(state.materializeAttachmentsForSend(state.pendingAttachments.value, 'session-1'), /b.txt 不存在/);
  await state.loadSessionFiles('session-1');
  const deleting = state.removeSessionFile(state.sessionFiles.value[0]);
  deps.currentSessionId.value = 'session-2';
  completeDelete();
  await deleting;
  assert.deepEqual(calls, [['session-1', 'linked-0']]);
  deps.currentSessionId.value = 'session-1';
  missingSecondFile = false;
  const result = await state.materializeAttachmentsForSend(state.pendingAttachments.value, 'session-1');
  assert.deepEqual(registered.map(file => file.original_name), ['a.txt', 'a.txt', 'b.txt']);
  assert.deepEqual(result.map(file => file.file_id), ['linked-1', 'linked-2'], 'retry must not reuse the deleted file_id');
});
