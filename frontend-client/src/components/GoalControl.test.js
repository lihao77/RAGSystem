import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./chat/GoalControl.vue', import.meta.url), 'utf8');

test('GoalControl keeps initial load failures visible and retryable without a loaded goal', () => {
  assert.match(source, /v-if="goal \|\| error"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /@click="loadGoal\(\)"/);
  assert.match(source, /刷新 Goal/);
});
