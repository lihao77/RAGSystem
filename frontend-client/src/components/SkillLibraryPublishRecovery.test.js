import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../views/SkillLibrary.vue', import.meta.url), 'utf8');

test('published Skill bundles are read-only and deleting one refreshes drafts', () => {
  assert.match(source, /发布包只读/);
  assert.match(source, /await Promise\.allSettled\(\[refresh\(\), loadDrafts\(\)\]\)/);
  assert.match(source, /删除后其 Draft 会恢复为可编辑状态/);
  assert.doesNotMatch(source, /恢复发布/);
});
