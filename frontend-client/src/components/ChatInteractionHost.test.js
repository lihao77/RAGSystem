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
  // composer 是交互区之后的无条件兜底分支（主对话列永远是根会话，不再按参与者分叉）；
  // 子智能体线程改由运行工作台承载，不再占用主对话列。
  assert.equal(/v-else\s+key="composer"/.test(viewSource), true);
  assert.equal(viewSource.includes('ParticipantThreadEmpty'), false);
  assert.equal(viewSource.includes('<RunWorkbench'), true);
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
  const workbenchSource = await readFile(new URL('./workpanel/RunWorkbench.vue', import.meta.url), 'utf8');

  assert.equal(overviewSource.includes('<WorkPanelApproval'), false);
  assert.equal(overviewSource.includes('<WorkPanelUserInput'), false);
  assert.equal(overviewSource.includes('approvalQueue'), false);
  assert.equal(overviewSource.includes('pendingUserInput'), false);
  // 运行工作台里的概览同样不承担审批：审批操作仍由聊天区 ChatInteractionHost 承担。
  assert.equal(workbenchSource.includes('<WorkPanelApproval'), false);
  assert.equal(workbenchSource.includes('<WorkPanelUserInput'), false);
  assert.equal(workbenchSource.includes('ApprovalDialog'), false);
  assert.equal(workbenchSource.includes('UserInputDialog'), false);
});
