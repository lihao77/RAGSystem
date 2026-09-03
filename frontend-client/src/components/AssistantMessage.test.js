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
  // spinner 带 loading-spinner 钩子：chat-view.css 里与步骤行图标同格（14×14）对齐
  assert.equal(source.includes('<Spinner class="loading-spinner" aria-hidden="true"'), true);
  assert.equal(source.includes('role="status"'), true);
  assert.equal(source.includes('aria-live="polite"'), true);
});

test('执行步骤中的 intent 使用 final 相同的 Markdown 渲染，运行结束自动收起过程区', async () => {
  const source = await readFile(new URL('./chat/AssistantExecutionSteps.vue', import.meta.url), 'utf8');
  const nodeSource = await readFile(new URL('./chat/AssistantExecutionNode.vue', import.meta.url), 'utf8');

  assert.equal(source.includes('<AssistantExecutionNode'), true);
  assert.equal(nodeSource.includes(':content="node.intent || \'\'"'), true);
  assert.equal(nodeSource.includes('class="assistant-step-intent"'), true);
  // 运行开始展开过程、结束收起（答案由下方 assistant 消息槽呈现）；用户手动展开仍可用。
  assert.equal(source.includes('watch(running'), true);
  assert.equal(source.includes('expanded.value = isRunning'), true);
  // 树只承载过程：不建答案节点，答案由消息槽 assistant 行渲染，避免双路径。
  assert.equal(source.includes('answerNode'), false);
  assert.equal(nodeSource.includes("node.type === 'answer'"), false);
  assert.equal(source.includes('ensureExecutionStepsLoaded'), true);
  // 点开过的段懒加载后发现树为空：面板保留并显示"暂无执行步骤"，不原地消失。
  assert.equal(source.includes('暂无执行步骤'), true);
  assert.equal(source.includes('userRevealed.value = true'), true);
  assert.equal(source.includes('|| userRevealed.value,'), true);
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
  // 运行态指示：图标保持不变，步骤名以“光拂过”shimmer 呈现（旋转 spinner 已移除）
  assert.equal(nodeSource.includes('is-shimmer'), true);
  assert.equal(nodeSource.includes('assistant-step-spinner'), false);
  // loading 行与执行时间线排成同一条流：spinner 14×14 贴行首、14px/1.7 与
  // step/final/intent 同基线（详见 chat-view.css 的 .loading-indicator 注释）
  assert.equal(styles.includes('.loading-indicator .loading-spinner'), true);
  assert.equal(styles.includes('padding: 4px var(--spacing-sm)'), false);
  assert.equal(styles.includes('--message-list-gap: 16px'), true);
  assert.equal(styles.includes('--message-bubble-radius: 16px'), true);
  assert.equal(styles.includes('max-width: 80%'), true);
});

test('运行概览收进顶栏胶囊,Goal 与后台任务合并在同一概览', async () => {
  const barSource = await readFile(new URL('./chat/SessionContextBar.vue', import.meta.url), 'utf8');
  const capsuleSource = await readFile(new URL('./chat/RuntimeCapsule.vue', import.meta.url), 'utf8');
  const overviewSource = await readFile(new URL('./workpanel/RuntimeOverviewPanel.vue', import.meta.url), 'utf8');
  const nodeSource = await readFile(new URL('./chat/AssistantExecutionNode.vue', import.meta.url), 'utf8');
  const actionsSource = await readFile(new URL('./chat/MessageActions.vue', import.meta.url), 'utf8');

  // 顶栏入口是胶囊:折叠态摘要,点开 Popover 即完整运行概览,不再有侧边抽屉。
  assert.equal(barSource.includes('<RuntimeCapsule'), true);
  assert.equal(capsuleSource.includes('aria-label="打开运行概览"'), true);
  assert.equal(capsuleSource.includes('<RuntimeOverviewPanel'), true);
  assert.equal(capsuleSource.includes('RuntimeCenterHost'), false);
  assert.equal(capsuleSource.includes('<Sheet'), false);
  assert.equal((capsuleSource.match(/emit\('select-participant'/g) || []).length, 1);
  assert.equal(capsuleSource.includes('待审批'), true);
  assert.equal(overviewSource.includes('<GoalPanel v-if="showGoalSection"'), true);
  assert.equal(overviewSource.includes('<BackgroundTasksPanel v-if="showTaskSection"'), true);
  assert.equal(overviewSource.includes('执行详情'), false);
  assert.equal(nodeSource.includes('完整详情'), false);
  assert.equal(actionsSource.includes('在运行中心查看执行树'), false);
});

test('工具调用详情按工具类型分化：bash 终端块、edit diff 块、其余分段/兜底', async () => {
  const nodeSource = await readFile(new URL('./chat/AssistantExecutionNode.vue', import.meta.url), 'utf8');
  const detailSource = await readFile(new URL('./chat/AssistantToolCallDetail.vue', import.meta.url), 'utf8');

  // 渲染节点只负责行与折叠，工具详情整体交给专用组件
  assert.equal(nodeSource.includes('<AssistantToolCallDetail'), true);
  assert.equal(nodeSource.includes('formatArguments'), false);
  // 三种形态：终端(execute_bash) → diff(edit_file) → 通用参数/结果（不做 per-tool 分段适配）
  assert.equal(detailSource.includes('v-if="terminalView"'), true);
  assert.equal(detailSource.includes('v-else-if="diffView"'), true);
  assert.equal(detailSource.includes('getToolTerminalView'), true);
  assert.equal(detailSource.includes('getToolDiffView'), true);
  assert.equal(detailSource.includes('getToolFallbackText'), true);
  assert.equal(detailSource.includes('getToolInputSections'), false);
  assert.equal(detailSource.includes('getToolOutputSections'), false);
  // 终端语义：$ 提示符 + stdout/stderr 分色 + 退出码徽标；diff 语义：+/- 标记与增删行着色
  assert.equal(detailSource.includes('tool-terminal__prompt'), true);
  assert.equal(detailSource.includes('tool-terminal__stdout'), true);
  assert.equal(detailSource.includes('tool-terminal__stderr'), true);
  assert.equal(detailSource.includes('tool-terminal__exit'), true);
  assert.equal(detailSource.includes('tool-diff__mark'), true);
  assert.equal(detailSource.includes('color-mix(in srgb, var(--color-success) 8%, transparent)'), true);
  assert.equal(detailSource.includes('color-mix(in srgb, var(--color-error) 8%, transparent)'), true);
  // 详情运行态以节点 status 为准（run 级 running 只做门控）：run 进行中已完成
  // 的工具立即呈现结果/退出码，仅真正执行中的工具显示“执行中”。
  assert.equal(detailSource.includes("props.running && status.value === 'running'"), true);
  assert.equal(detailSource.includes('v-if="toolRunning"'), true);
  assert.equal(detailSource.includes('!toolRunning.value'), true);
});
