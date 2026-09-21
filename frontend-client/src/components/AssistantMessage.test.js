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
  assert.equal(styles.includes('--message-list-gap: 20px'), true);
  // 移动端压缩间距改的是间距变量本身：flex 下 gap 不与子项 margin-top 折叠，
  // 再给 .message-stream 加 gap 会把间距顶成 28px
  assert.equal(styles.includes('--message-list-gap: var(--spacing-sm)'), true);
  assert.equal(/\.message-stream \{[^}]*[;{]\s*gap:/.test(styles), false);
  assert.equal(styles.includes('--message-bubble-radius: 16px'), true);
  assert.equal(styles.includes('max-width: 80%'), true);
});

test('输入区与消息区共用同一条左右边界', async () => {
  const styles = await readFile(new URL('../styles/chat-view.css', import.meta.url), 'utf8');
  const wrapper = /\.input-area-wrapper \{[\s\S]*?\n\}/.exec(styles)?.[0];
  const messages = /\.chat-messages \{[\s\S]*?\n\}/.exec(styles)?.[0];
  assert.ok(wrapper && messages, '应能读到输入区与消息区的规则');

  // 输入区此前固定 16px：宽屏下比消息列窄 32px、窄屏下反而更宽，两处取同一个变量才对齐
  assert.equal(wrapper.includes('padding: 0 var(--chat-padding-x);'), true);
  assert.equal(messages.includes('padding: var(--chat-padding-y) var(--chat-padding-x);'), true);
  assert.equal(styles.includes('--input-area-padding-x'), false);
});

test('过程行缩进步长由图标尺寸与行内间距推出', async () => {
  const nodeSource = await readFile(new URL('./chat/AssistantExecutionNode.vue', import.meta.url), 'utf8');

  const iconSize = /\.assistant-step-icon \{[\s\S]*?width: (\d+)px/.exec(nodeSource)?.[1];
  const rowGap = /\.assistant-step-row \{[\s\S]*?gap: (\d+)px/.exec(nodeSource)?.[1];
  assert.ok(iconSize && rowGap, '应能读到步骤图标尺寸与行内 gap');

  // 行首 / 展开体 / 思考竖线三个缩进公式都从这两个常量推出；改了样式尺寸这里会拦住
  assert.equal(nodeSource.includes(`const STEP_ICON_SIZE = ${iconSize};`), true);
  assert.equal(nodeSource.includes(`const STEP_ROW_GAP = ${rowGap};`), true);
  assert.equal(nodeSource.includes('* 22'), false);
});

test('运行概览收进右侧工作台卡,Goal 与后台任务合并在同一概览', async () => {
  const barSource = await readFile(new URL('./chat/SessionContextBar.vue', import.meta.url), 'utf8');
  const workbenchSource = await readFile(new URL('./workpanel/RunWorkbench.vue', import.meta.url), 'utf8');
  const overviewSource = await readFile(new URL('./workpanel/RuntimeOverviewPanel.vue', import.meta.url), 'utf8');
  const nodeSource = await readFile(new URL('./chat/AssistantExecutionNode.vue', import.meta.url), 'utf8');
  const actionsSource = await readFile(new URL('./chat/MessageActions.vue', import.meta.url), 'utf8');

  // 概览住在工作台卡里（智能体清单 + 目标 + 后台任务），表头只留面板的展开入口，
  // 不再有顶栏胶囊，也没有旧的侧边抽屉形态。
  assert.equal(barSource.includes('<RuntimeCapsule'), false);
  assert.equal(barSource.includes('展开运行工作台'), true);
  assert.equal(workbenchSource.includes('<RuntimeOverviewPanel'), true);
  assert.equal(workbenchSource.includes('RuntimeCenterHost'), false);
  assert.equal(workbenchSource.includes('<Sheet'), false);
  // 两个出口通向同一个页签：概览里的智能体清单，以及切到还没拉过内容的页签时补一次取数。
  assert.equal((workbenchSource.match(/emit\('select-participant'/g) || []).length, 2);
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
  // 三种形态：终端(execute_shell) → diff(edit_file) → 通用参数/结果（不做 per-tool 分段适配）
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
