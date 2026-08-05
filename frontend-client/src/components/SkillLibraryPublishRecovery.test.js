import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../views/SkillLibrary.vue', import.meta.url), 'utf8');

test('published Skill bundles update through editable Drafts and deleting one refreshes drafts', () => {
  assert.match(source, /通过 Draft 更新/);
  assert.match(source, /编辑草稿/);
  assert.match(source, /ensureSkillDraft/);
  assert.match(source, /updateSkillDraft/);
  assert.match(source, /重新发布/);
  assert.match(source, /await Promise\.allSettled\(\[refresh\(\), loadDrafts\(\)\]\)/);
  assert.match(source, /删除后其 Draft 会恢复为可编辑状态/);
});
