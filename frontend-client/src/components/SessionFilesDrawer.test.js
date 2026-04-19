import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('SessionFilesDrawer 不再保留独立拖拽上传入口，避免与窗口级拖拽重复触发', async () => {
  const filePath = new URL('./SessionFilesDrawer.vue', import.meta.url);
  const source = await readFile(filePath, 'utf8');

  assert.equal(source.includes('@drop.prevent="handleDrop"'), false);
  assert.equal(source.includes('const handleDrop ='), false);
  assert.equal(source.includes('isDragOver = ref'), false);
});
