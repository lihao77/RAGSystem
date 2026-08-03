import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dialogSource = readFileSync(new URL('./ui/dialog/DialogContent.vue', import.meta.url), 'utf8');
const alertSource = readFileSync(new URL('./ui/alert-dialog/AlertDialogContent.vue', import.meta.url), 'utf8');

test('AlertDialog renders above an already-open Dialog', () => {
  assert.match(dialogSource, /\bz-50\b/);
  assert.equal((alertSource.match(/z-\[60\]/g) ?? []).length, 2);
});
