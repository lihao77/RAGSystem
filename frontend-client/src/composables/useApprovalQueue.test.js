import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

import { useApprovalQueue } from './useApprovalQueue.js';

function createDeps(overrides = {}) {
  return {
    currentSessionId: ref('session-1'),
    filePreviewDialogRef: ref(null),
    respondInteraction: async () => {},
    showToast: () => {},
    ...overrides,
  };
}

test('聊天区用户输入提交失败时保留 pendingUserInput', async () => {
  const deps = createDeps();
  const queue = useApprovalQueue(deps);
  const submit = async () => {
    throw new Error('submit failed');
  };

  queue.showUserInput({ input_id: 'input-1', prompt: 'scope?' }, submit, async () => {});
  const pending = queue.pendingUserInput.value;

  await queue.handleUserInputSubmit({ inputId: 'input-1', value: 'session' });

  assert.equal(queue.pendingUserInput.value, pending);
});

test('聊天区用户输入提交成功后等待 runtime 快照清理 pendingUserInput', async () => {
  const deps = createDeps();
  const queue = useApprovalQueue(deps);

  queue.showUserInput({ input_id: 'input-1', prompt: 'scope?' }, async () => {}, async () => {});

  await queue.handleUserInputSubmit({ inputId: 'input-1', value: 'session' });

  assert.notEqual(queue.pendingUserInput.value, null);
});

test('收到用户输入时始终交给聊天区渲染，不打开运行中心', () => {
  const opened = [];
  const deps = createDeps({ openExecutionPanel: () => opened.push('execution') });
  const queue = useApprovalQueue(deps);

  queue.showUserInput({ input_id: 'input-1', prompt: 'scope?' }, async () => {}, async () => {});

  assert.deepEqual(opened, []);
  assert.equal(queue.pendingUserInput.value.data.input_id, 'input-1');
  assert.equal(queue.approvalQueue.value.length, 0);
});

test('普通审批进入聊天区队列，不打开运行中心或审批弹窗', () => {
  const opened = [];
  const deps = createDeps({
    openExecutionPanel: () => opened.push('execution'),
  });
  const queue = useApprovalQueue(deps);

  queue.enqueueApproval(
    { call_id: 'approval-1', agent_id: 'root' },
    { tool: 'write_file', risk_level: 'medium', message: '允许写入文件吗？' },
    'session-1',
  );

  assert.deepEqual(opened, []);
  assert.equal(queue.approvalQueue.value[0].approval_id, 'approval-1');
  assert.equal(queue.approvalQueue.value[0].tool_name, 'write_file');
});

test('文件读取确认继续使用专用预览对话框', () => {
  const shown = [];
  const deps = createDeps({
    filePreviewDialogRef: ref({
      hide: () => {},
      show: approval => shown.push(approval),
    }),
  });
  const queue = useApprovalQueue(deps);

  queue.enqueueApproval(
    { call_id: 'approval-file-1', agent_id: 'root' },
    { tool: 'read_file', approval_type: 'file_read_confirm' },
    'session-1',
  );

  assert.equal(shown.length, 1);
  assert.equal(shown[0].approval_id, 'approval-file-1');
});
