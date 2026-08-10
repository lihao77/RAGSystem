import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('运行中的 assistant 把执行步骤渲染在消息流中，无步骤时才显示状态提示', async () => {
  const source = await readFile(new URL('./chat/AssistantMessage.vue', import.meta.url), 'utf8');

  assert.equal(source.includes('<AssistantExecutionSteps'), true);
  assert.equal(source.includes('v-if="showExecutionSteps"'), true);
  assert.equal(source.includes('v-if="showLoadingIndicator"'), true);
  assert.equal(source.includes('!props.msg.content && !props.msg.finished && !showExecutionSteps.value'), true);
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

test('工作栏展示权威运行状态并公开并发工具数量', async () => {
  const statusSource = await readFile(new URL('./workpanel/WorkPanelRunStatus.vue', import.meta.url), 'utf8');
  const panelSource = await readFile(new URL('./workpanel/WorkPanel.vue', import.meta.url), 'utf8');

  assert.equal(statusSource.includes("props.phase === 'tool_running'"), true);
  assert.equal(statusSource.includes('`工具执行中 · ${props.runningToolCount} 个`'), true);
  assert.equal(statusSource.includes('aria-live="polite"'), true);
  assert.equal(panelSource.includes(':running-tool-count="runningToolCount"'), true);
  assert.equal(panelSource.includes('Object.keys(props.activeRun?.runningToolCalls || {}).length'), true);
  assert.equal(panelSource.includes(':interrupted="messageInterrupted"'), true);
  assert.equal(statusSource.includes("props.interrupted"), true);
});
