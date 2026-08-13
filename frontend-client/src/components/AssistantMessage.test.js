import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('消息项按正文、操作按钮、执行步骤排列，正文组件不再夹带执行步骤', async () => {
  const source = await readFile(new URL('./chat/AssistantMessage.vue', import.meta.url), 'utf8');
  const userSource = await readFile(new URL('./chat/UserMessage.vue', import.meta.url), 'utf8');
  const itemSource = await readFile(new URL('./chat/ChatMessageItem.vue', import.meta.url), 'utf8');

  assert.equal(source.includes('<AssistantExecutionSteps'), false);
  assert.equal(userSource.includes('<AssistantExecutionSteps'), false);
  assert.equal(itemSource.indexOf('<AssistantExecutionSteps') > itemSource.indexOf('<MessageActions'), true);
  assert.equal(source.includes('v-if="showLoadingIndicator"'), true);
  assert.equal(source.includes('!props.msg.content && !props.msg.finished'), true);
  assert.equal(source.includes('getAssistantRuntimeStatusText(msg)'), true);
  assert.equal(source.includes('<Spinner aria-hidden="true"'), true);
  assert.equal(source.includes('role="status"'), true);
  assert.equal(source.includes('aria-live="polite"'), true);
});

test('执行步骤中的 intent 使用 final 相同的 Markdown 渲染，并在 final 后自动折叠', async () => {
  const source = await readFile(new URL('./chat/AssistantExecutionSteps.vue', import.meta.url), 'utf8');
  const nodeSource = await readFile(new URL('./chat/AssistantExecutionNode.vue', import.meta.url), 'utf8');

  assert.equal(source.includes('<AssistantExecutionNode'), true);
  assert.equal(nodeSource.includes(':content="node.intent || \'\'"'), true);
  assert.equal(nodeSource.includes('class="assistant-step-intent"'), true);
  assert.equal(source.includes('watch(finalVisible'), true);
  assert.equal(source.includes('expanded.value = false'), true);
  assert.equal(source.includes('ensureExecutionStepsLoaded'), true);
});

test('用户和智能体消息由消息项共用执行步骤，最终 assistant 不显示入口', async () => {
  const source = await readFile(new URL('./chat/ChatMessageItem.vue', import.meta.url), 'utf8');

  assert.equal(source.includes('<AssistantExecutionSteps'), true);
  assert.equal(source.includes(':msg="msg"'), true);
  assert.equal(source.includes("props.msg.role === 'user'"), true);
  assert.equal(source.includes("props.msg.role === 'user' || props.msg.role === 'assistant'"), false);
});

test('消息列表复用 Widget 的紧凑气泡和工具调用视觉结构', async () => {
  const stepsSource = await readFile(new URL('./chat/AssistantExecutionSteps.vue', import.meta.url), 'utf8');
  const nodeSource = await readFile(new URL('./chat/AssistantExecutionNode.vue', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../styles/chat-view.css', import.meta.url), 'utf8');

  assert.equal(stepsSource.includes('assistant-execution-list-outer'), true);
  assert.equal(stepsSource.includes('`${toolCount.value} 个工具调用`'), true);
  assert.equal(nodeSource.includes('class="assistant-step-row"'), true);
  assert.equal(nodeSource.includes('class="assistant-step-detail-wrap"'), true);
  assert.equal(styles.includes('--message-list-gap: 16px'), true);
  assert.equal(styles.includes('--message-bubble-radius: 16px'), true);
  assert.equal(styles.includes('max-width: 80%'), true);
});

test('运行中心按需打开并将 Goal 与后台任务合并在同一概览', async () => {
  const barSource = await readFile(new URL('./chat/SessionContextBar.vue', import.meta.url), 'utf8');
  const hostSource = await readFile(new URL('./chat/RuntimeCenterHost.vue', import.meta.url), 'utf8');
  const panelSource = await readFile(new URL('./workpanel/WorkPanel.vue', import.meta.url), 'utf8');
  const overviewSource = await readFile(new URL('./workpanel/RuntimeOverviewPanel.vue', import.meta.url), 'utf8');
  const nodeSource = await readFile(new URL('./chat/AssistantExecutionNode.vue', import.meta.url), 'utf8');
  const actionsSource = await readFile(new URL('./chat/MessageActions.vue', import.meta.url), 'utf8');

  assert.equal((barSource.match(/@click="emit\('openRuntimeCenter'/g) || []).length, 1);
  assert.equal(barSource.includes('aria-label="打开运行中心"'), true);
  assert.equal(hostSource.includes('<Sheet :open="open"'), true);
  assert.equal(hostSource.includes('isWideScreen'), false);
  assert.equal(panelSource.includes('<RuntimeOverviewPanel'), true);
  assert.equal(panelSource.includes('<FileOutputPanel'), false);
  assert.equal(panelSource.includes('WorkPanelExecution'), false);
  assert.equal(overviewSource.includes('<GoalPanel v-if="showGoalSection" embedded'), true);
  assert.equal(overviewSource.includes('<BackgroundTasksPanel v-if="showTaskSection" embedded'), true);
  assert.equal(overviewSource.includes('执行详情'), false);
  assert.equal(nodeSource.includes('完整详情'), false);
  assert.equal(actionsSource.includes('在运行中心查看执行树'), false);
});
