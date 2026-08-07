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

test('filters collapse into a single compact trigger button', () => {
  assert.match(toolbarSource, /session-filter-btn/);
  assert.match(toolbarSource, /ListFilter/);
  assert.match(toolbarSource, /triggerLabel/);
  assert.match(toolbarSource, /activeFilterCount/);
  assert.match(toolbarSource, /return '筛选'/);
  assert.match(toolbarSource, /return '已筛选'/);
  assert.equal((toolbarSource.match(/session-filter-chip/g) || []).length, 0);
});

test('single panel contains both source and workspace filters', () => {
  assert.match(toolbarSource, /session-filter-panel/);
  assert.match(toolbarSource, />来源</);
  assert.match(toolbarSource, />工作区</);
  assert.match(toolbarSource, /全部工作区/);
  assert.match(toolbarSource, /FolderOpen/);
  assert.match(toolbarSource, /MessageSquare/);
  assert.match(toolbarSource, /Bot/);
  assert.match(toolbarSource, /AppWindow/);
});

test('source menu is grouped and hides empty specific origins', () => {
  assert.match(toolbarSource, /DropdownMenuSeparator/);
  assert.match(toolbarSource, /origin\.count > 0/);
  assert.match(toolbarSource, /indent: true/);
});

test('active filters show badge and panel clear action', () => {
  assert.match(toolbarSource, /is-active': hasFilters/);
  assert.match(toolbarSource, /session-filter-btn__badge/);
  assert.match(toolbarSource, /clearAll/);
  assert.match(toolbarSource, /清除全部筛选/);
  assert.match(toolbarSource, /emit\('clear'\)/);
});

test('filter trigger lives in the session list header', () => {
  assert.match(listSource, /SessionListToolbar/);
  assert.match(listSource, /@clear="clearFilters"/);
  assert.doesNotMatch(listSource, /FilterX/);
});

test('background facet refresh keeps a populated toolbar enabled', () => {
  assert.match(listSource, /loadingFacets && !hasFacetData/);
  assert.match(listSource, /Object\.values\(facets\.value\.type_counts\)\.some\(count => count > 0\)/);
});

test('empty states distinguish no sessions from filtered miss', () => {
  assert.match(listSource, /还没有会话/);
  assert.match(listSource, /没有符合条件的会话/);
  assert.match(listSource, /!items\.length && hasFilters/);
  assert.match(listSource, /@click="clearFilters"/);
});

test('filter refresh keeps list content with soft transition instead of hard skeleton swap', () => {
  assert.match(listSource, /isSoftRefreshing/);
  assert.match(listSource, /showSkeleton/);
  assert.match(listSource, /loadingInitial\.value && items\.value\.length > 0/);
  assert.match(listSource, /session-stage/);
  assert.match(listSource, /is-soft-refreshing/);
});

test('project view only groups sessions from active workspaces', () => {
  assert.match(listSource, /if \(!groups\.has\(id\)\) continue/);
  assert.match(listSource, /id === '__unassigned__'/);
  assert.match(listSource, /remove-workspace/);
  assert.match(listSource, /移除项目/);
});

test('timeline items show workspace context while project items stay compact', () => {
  const timelineStart = listSource.indexOf('<TransitionGroup v-else');
  const timelineEnd = listSource.indexOf('</TransitionGroup>', timelineStart);
  const timelineSource = listSource.slice(timelineStart, timelineEnd);
  assert.doesNotMatch(timelineSource, /\bcompact\b/);
  assert.match(listSource, /v-for="item in group\.items"[\s\S]*?\bcompact\b/);
});
