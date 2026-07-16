import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./knowledge/MarkdownEditor.vue', import.meta.url), 'utf8');

test('MarkdownEditor remains a controlled editor without bundling Vditor', () => {
  assert.match(source, /<textarea/);
  assert.match(source, /:value="modelValue"/);
  assert.match(source, /emit\('update:modelValue'/);
  assert.match(source, /emit\('save'\)/);
  assert.doesNotMatch(source, /import\(['"]vditor['"]\)/);
});
