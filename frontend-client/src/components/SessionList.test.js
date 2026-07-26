import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const toolbarSource = readFileSync(new URL('./session-list/SessionListToolbar.vue', import.meta.url), 'utf8');
const listSource = readFileSync(new URL('./session-list/SessionList.vue', import.meta.url), 'utf8');

test('session list filters expose radio menu semantics', () => {
  assert.match(toolbarSource, /DropdownMenuRadioGroup/);
  assert.match(toolbarSource, /DropdownMenuRadioItem/);
  assert.doesNotMatch(toolbarSource, /<DropdownMenuItem/);
});

test('background facet refresh keeps a populated toolbar enabled', () => {
  assert.match(listSource, /loadingFacets && !hasFacetData/);
  assert.match(listSource, /Object\.values\(facets\.value\.type_counts\)\.some\(count => count > 0\)/);
});
