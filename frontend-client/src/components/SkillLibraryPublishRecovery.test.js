import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../views/SkillLibrary.vue', import.meta.url), 'utf8');

test('published Skill drafts expose recovery and refresh a stale revision after failure', () => {
  assert.match(source, /draftReviewReadonly \? '恢复发布' : '发布 Skill'/);
  assert.match(source, /const latest = await getSkillDraft\(current\.id\)/);
  assert.match(source, /title: recovering \? '恢复 Skill 发布' : '发布 Skill 草稿'/);
  assert.match(source, /draftReview\.value\.draft\?\.package_state === 'missing'/);
  assert.match(source, /@click="confirmDeleteDraft"/);
  assert.match(source, /await deleteSkillDraft\(current\.id, current\.revision\)/);
  assert.match(source, /await Promise\.allSettled\(\[refresh\(\), loadDrafts\(\)\]\)/);
  assert.match(source, /res\?\.data\?\.restored_draft/);
});
