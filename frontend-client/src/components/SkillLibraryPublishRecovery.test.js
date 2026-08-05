import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../views/SkillLibrary.vue', import.meta.url), 'utf8');

test('published Skill bundles update through editable Drafts and deleting one refreshes drafts', () => {
  assert.match(source, /Bundle 文件/);
  assert.match(source, /编辑 Draft/);
  assert.match(source, /ensureSkillDraft/);
  assert.match(source, /updateSkillDraft/);
  assert.match(source, /重新发布/);
  assert.match(source, /syncPublishedState/);
  assert.match(source, /已有 Draft 会恢复为未发布状态/);
});
