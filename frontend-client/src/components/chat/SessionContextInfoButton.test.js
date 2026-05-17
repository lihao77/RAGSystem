import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('SessionContextInfoButton 使用 Teleport + fixed，避免弹层撑开中间滚动容器', async () => {
  const filePath = new URL('./SessionContextInfoButton.vue', import.meta.url);
  const source = await readFile(filePath, 'utf8');

  assert.equal(source.includes('<Teleport to="body">'), true);
  assert.equal(source.includes('position: fixed;'), true);
  assert.equal(source.includes('session-context-popover'), true);
  assert.equal(source.includes('inside: [contextContainerRef, metaPanelRef]'), true);
});
