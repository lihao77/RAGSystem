import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

import { useApprovalQueue } from './useApprovalQueue.js';

function createDeps(overrides = {}) {
  return {
    showWorkPanel: ref(true),
    currentSessionId: ref('session-1'),
    approvalQueueHostRef: ref(null),
    filePreviewDialogRef: ref(null),
    respondInteraction: async () => {},
    showToast: () => {},
    ...overrides,
  };
}

test('工作面板用户输入提交失败时保留 pendingUserInput', async () => {
  const deps = createDeps();
  const queue = useApprovalQueue(deps);
  const submit = async () => {
    throw new Error('submit failed');
  };

  queue.showUserInput({ input_id: 'input-1', prompt: 'scope?' }, submit, async () => {});
  const pending = queue.pendingUserInput.value;

  await queue.handleWorkPanelUserInputSubmit({ inputId: 'input-1', value: 'session' });

  assert.equal(queue.pendingUserInput.value, pending);
});

test('工作面板用户输入提交成功后清理 pendingUserInput', async () => {
  const deps = createDeps();
  const queue = useApprovalQueue(deps);

  queue.showUserInput({ input_id: 'input-1', prompt: 'scope?' }, async () => {}, async () => {});

  await queue.handleWorkPanelUserInputSubmit({ inputId: 'input-1', value: 'session' });

  assert.equal(queue.pendingUserInput.value, null);
});

test('窄屏收到用户输入时先打开运行中心执行标签', () => {
  const showWorkPanel = ref(false);
  const opened = [];
  const deps = createDeps({
    showWorkPanel,
    openExecutionPanel: () => {
      opened.push('execution');
      showWorkPanel.value = true;
    },
  });
  const queue = useApprovalQueue(deps);

  queue.showUserInput({ input_id: 'input-1', prompt: 'scope?' }, async () => {}, async () => {});

  assert.deepEqual(opened, ['execution']);
  assert.equal(queue.pendingUserInput.value.data.input_id, 'input-1');
  assert.equal(queue.approvalQueue.value.length, 0);
});
