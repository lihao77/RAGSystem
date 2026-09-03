import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('/compact 的 command_result 渲染为横线分隔形式，其他命令保持卡片', async () => {
  const source = await readFile(new URL('./CommandResultMessage.vue', import.meta.url), 'utf8');

  // compact 走横线分支：两侧 divider-line + 居中文字，不再显示 /compact 命令名前缀。
  assert.equal(source.includes("props.result.name === 'compact'"), true);
  assert.equal(source.includes('compact-divider'), true);
  assert.equal(source.includes('class="divider-line"'), true);
  assert.equal(source.includes('class="divider-text"'), true);
  // 横线分支与卡片分支并存（v-if / v-else），其他命令的渲染不受影响。
  const dividerIdx = source.indexOf('compact-divider');
  const cardIdx = source.indexOf("'command-result', statusClass");
  assert.equal(dividerIdx > -1 && cardIdx > dividerIdx, true);
  // 失败态横线仍有 error 配色（压缩失败可见）。
  assert.equal(source.includes('.compact-divider.error'), true);
});

test('手动压缩进行中由 CompactPendingDivider 承载（光拂过同款），ChatMessageItem 按 msg_type 分流', async () => {
  const itemSource = await readFile(new URL('./chat/ChatMessageItem.vue', import.meta.url), 'utf8');
  const dividerSource = await readFile(new URL('./chat/CompactPendingDivider.vue', import.meta.url), 'utf8');

  // ChatMessageItem：pending 横线优先于 command_result 卡片分流。
  assert.equal(itemSource.includes('CompactPendingDivider'), true);
  assert.equal(itemSource.includes("'context_compression_pending'"), true);
  assert.equal(
    itemSource.indexOf('isCompactPending') < itemSource.indexOf('v-else-if="commandResult"'),
    true,
  );
  // 光拂过：与 AssistantExecutionNode 同款 sweep（300% size + 150%→0% 无缝循环）。
  assert.equal(dividerSource.includes('background-size: 300% 100%'), true);
  assert.equal(dividerSource.includes('150% 0'), true);
  assert.equal(dividerSource.includes('0% 0'), true);
  assert.equal(dividerSource.includes('正在压缩…'), true);
  // 动效可访问性：prefers-reduced-motion 下退化为静态文本。
  assert.equal(dividerSource.includes('prefers-reduced-motion'), true);
});
