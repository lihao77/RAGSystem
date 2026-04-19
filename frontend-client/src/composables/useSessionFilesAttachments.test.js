import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

import { useSessionFilesAttachments } from './useSessionFilesAttachments.js';

function createDeps(overrides = {}) {
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

test('materializeAttachmentsForSend 会批量上传本地附件并保持顺序', async () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalFetch = global.fetch;
  URL.createObjectURL = (file) => `blob:${file.name}`;
  URL.revokeObjectURL = () => {};

  global.fetch = async (url, options = {}) => {
    if (String(url).includes('/files/upload')) {
      const entries = Array.from(options.body.getAll('files'));
      assert.equal(entries.length, 2);
      return {
        ok: true,
        json: async () => ({
          files: [
            { id: 'file-1', original_name: 'a.png', stored_name: 'stored-a.png', mime: 'image/png', size: 1 },
            { id: 'file-2', original_name: 'b.txt', stored_name: 'stored-b.txt', mime: 'text/plain', size: 1 },
          ],
        }),
      };
    }
    if (String(url).match(/\/files$/)) {
      return {
        ok: true,
        json: async () => ({ files: [] }),
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const { deps } = createDeps();
  const state = useSessionFilesAttachments(deps);
  await state.handleSessionFileSelect([
    new File(['a'], 'a.png', { type: 'image/png' }),
    new File(['b'], 'b.txt', { type: 'text/plain' }),
  ]);

  const result = await state.materializeAttachmentsForSend(state.pendingAttachments.value.slice(), 'session-1');

  assert.deepEqual(result.map(item => item.file_id), ['file-1', 'file-2']);
  assert.deepEqual(result.map(item => item.source), ['session', 'session']);

  global.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});
