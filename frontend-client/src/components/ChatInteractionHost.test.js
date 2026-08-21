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

test('运行概览不接收或渲染审批和用户输入', async () => {
  const overviewSource = await readFile(new URL('./workpanel/RuntimeOverviewPanel.vue', import.meta.url), 'utf8');
  const capsuleSource = await readFile(new URL('./chat/RuntimeCapsule.vue', import.meta.url), 'utf8');

  assert.equal(overviewSource.includes('<WorkPanelApproval'), false);
  assert.equal(overviewSource.includes('<WorkPanelUserInput'), false);
  assert.equal(overviewSource.includes('approvalQueue'), false);
  assert.equal(overviewSource.includes('pendingUserInput'), false);
  // 胶囊只展示待审批数量横幅,审批操作仍由聊天区 ChatInteractionHost 承担。
  assert.equal(capsuleSource.includes('<WorkPanelApproval'), false);
  assert.equal(capsuleSource.includes('<WorkPanelUserInput'), false);
  assert.equal(capsuleSource.includes('ApprovalDialog'), false);
  assert.equal(capsuleSource.includes('UserInputDialog'), false);
});
