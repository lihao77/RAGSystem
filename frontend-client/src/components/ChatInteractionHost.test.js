import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('审批和用户输入挂载在聊天主区域', async () => {
  const viewSource = await readFile(new URL('../views/ChatViewV2.vue', import.meta.url), 'utf8');
  const hostSource = await readFile(new URL('./chat/ChatInteractionHost.vue', import.meta.url), 'utf8');
  const styleSource = await readFile(new URL('../styles/chat-view.css', import.meta.url), 'utf8');

  assert.equal(viewSource.includes('<ChatInteractionHost'), true);
  assert.equal(viewSource.includes(':approval-queue="chatApprovalQueue"'), true);
  assert.equal(viewSource.includes(':pending-user-input="pendingUserInput"'), true);
  assert.equal(viewSource.includes('<Transition name="chat-surface-swap" mode="out-in">'), true);
  assert.equal(viewSource.includes('v-if="approvalQueue.length || pendingUserInput"'), true);
  assert.equal(viewSource.includes('<ChatComposer'), true);
  assert.equal(viewSource.includes('v-else-if="isRootParticipant"'), true);
  assert.equal(viewSource.includes('key="composer"'), true);
  assert.equal(viewSource.includes('class="chat-messages-wrapper" ref="messagesRef"'), true);
  assert.equal(viewSource.includes('chat-bottom-region--interaction'), true);
  assert.equal(viewSource.includes('chat-bottom-region--new-chat'), true);
  assert.equal(viewSource.includes('.chat-surface-swap-enter-active'), true);
  assert.equal(viewSource.includes('.chat-surface-swap-leave-active'), true);
  assert.equal(styleSource.includes('position: sticky'), true);
  assert.equal(styleSource.includes('.chat-bottom-region--new-chat'), true);
  assert.equal(hostSource.includes('<WorkPanelApproval'), true);
  assert.equal(hostSource.includes('<WorkPanelUserInput'), true);
});

test('运行侧栏不再接收或渲染审批和用户输入', async () => {
  const panelSource = await readFile(new URL('./workpanel/WorkPanel.vue', import.meta.url), 'utf8');
  const hostSource = await readFile(new URL('./chat/RuntimeCenterHost.vue', import.meta.url), 'utf8');

  assert.equal(panelSource.includes('<WorkPanelApproval'), false);
  assert.equal(panelSource.includes('<WorkPanelUserInput'), false);
  assert.equal(panelSource.includes('approvalQueue'), false);
  assert.equal(panelSource.includes('pendingUserInput'), false);
  assert.equal(hostSource.includes(':approval-queue="approvalQueue"'), false);
  assert.equal(hostSource.includes(':pending-user-input="pendingUserInput"'), false);
  assert.equal(hostSource.includes('ApprovalDialog'), false);
  assert.equal(hostSource.includes('UserInputDialog'), false);
});
