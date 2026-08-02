import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('运行中的 assistant 即使已有执行树也保留状态提示', async () => {
  const source = await readFile(new URL('./chat/AssistantMessage.vue', import.meta.url), 'utf8');

  assert.equal(source.includes('v-if="!msg.content && !msg.finished"'), true);
  assert.equal(source.includes('v-if="!msg.content && !msg.executionTree?.root && !msg.finished"'), false);
  assert.equal(source.includes('getAssistantRuntimeStatusText(msg)'), true);
  assert.equal(source.includes('<Spinner aria-hidden="true"'), true);
  assert.equal(source.includes('role="status"'), true);
  assert.equal(source.includes('aria-live="polite"'), true);
});

test('工作栏展示权威运行状态并公开并发工具数量', async () => {
  const statusSource = await readFile(new URL('./workpanel/WorkPanelRunStatus.vue', import.meta.url), 'utf8');
  const panelSource = await readFile(new URL('./workpanel/WorkPanel.vue', import.meta.url), 'utf8');

  assert.equal(statusSource.includes("props.phase === 'tool_running'"), true);
  assert.equal(statusSource.includes('`工具执行中 · ${props.runningToolCount} 个`'), true);
  assert.equal(statusSource.includes('aria-live="polite"'), true);
  assert.equal(panelSource.includes(':running-tool-count="runningToolCount"'), true);
  assert.equal(panelSource.includes('Object.keys(props.activeRun?.runningToolCalls || {}).length'), true);
});
