import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('SessionContextInfoButton 使用 shadcn Popover（PopoverPortal teleport 到 body + fixed 定位，避免弹层撑开中间滚动容器）', async () => {
  const filePath = new URL('./SessionContextInfoButton.vue', import.meta.url);
  const source = await readFile(filePath, 'utf8');
  // shadcn Popover：PopoverContent 内部用 PopoverPortal（Teleport to body）+ fixed 定位，
  // 由 reka-ui 保证，不再自搓。这里验证用的是 shadcn Popover 而非自搓 Teleport。
  assert.equal(source.includes('PopoverContent'), true);
  assert.equal(source.includes('PopoverTrigger'), true);
  assert.equal(source.includes('session-context-popover'), true);
  // 确认不再有自搓定位/Teleport（已下线）
  assert.equal(source.includes('<Teleport to="body">'), false);
  assert.equal(source.includes('usePointerDownOutside'), false);
});
