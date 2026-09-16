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
  assert.match(toolbarSource, />项目</);
  assert.match(toolbarSource, /全部项目/);
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
  assert.match(listSource, /!items\.length && !pinnedItems\.length && hasFilters/);
  assert.match(listSource, /@click="clearFilters"/);
});

test('filter refresh keeps list content with soft transition instead of hard skeleton swap', () => {
  assert.match(listSource, /isSoftRefreshing/);
  assert.match(listSource, /showSkeleton/);
  assert.match(listSource, /loadingInitial\.value && items\.value\.length > 0/);
  assert.match(listSource, /session-stage/);
  assert.match(listSource, /is-soft-refreshing/);
});

test('project view pins the unassigned group last for switching back to no project', () => {
  assert.match(listSource, /groups\.set\(UNASSIGNED_WORKSPACE_ID/);
  assert.match(listSource, /未归属项目/);
  assert.match(listSource, /remove-workspace/);
  assert.match(listSource, /移除项目/);
});

test('project group menu offers rename next to remove', () => {
  assert.match(listSource, /rename-workspace/);
  assert.match(listSource, /重命名项目/);
});

test('project groups support drag reorder with collapse, live preview and expand-on-drop', () => {
  assert.match(listSource, /:draggable="Boolean\(group\.workspace\)"/);
  assert.match(listSource, /name="project-group"/);
  assert.match(listSource, /workspaceStore\.reorder\(previewIds\)/);
  assert.match(listSource, /collapseForDrag\(group\.id\)/);
  assert.match(listSource, /restoreAfterDrag\(id, wasCollapsed\)/);
  assert.match(listSource, /dragState\.value\.previewIds/);
  assert.match(listSource, /\.project-group-move/);
});

test('drag ghost is custom and locked to vertical movement only', () => {
  assert.match(listSource, /setDragImage\(ensureEmptyDragImage\(\), 0, 0\)/);
  assert.match(listSource, /project-drag-ghost/);
  assert.match(listSource, /@drag="onGroupDrag"/);
  // 只更新 top，left 恒为拖起时的原位
  assert.match(listSource, /dragGhost\.style\.top = /);
  assert.doesNotMatch(listSource, /dragGhost\.style\.left = \$\{.*clientX/);
  assert.match(listSource, /removeDragGhost\(\)/);
});

test('project group folder icon doubles as the collapse toggle', () => {
  assert.match(listSource, /project-session-group__toggle/);
  assert.match(listSource, /aria-expanded="!isCollapsed\(group\.id\)"/);
  assert.match(listSource, /<FolderOpen v-if="!isCollapsed\(group\.id\)"/);
  assert.match(listSource, /<Folder v-else class="project-session-group__icon"/);
  assert.doesNotMatch(listSource, /ChevronDown/);
});

test('timeline items show workspace context while project items stay compact', () => {
  const timelineStart = listSource.indexOf('<TransitionGroup v-else');
  const timelineEnd = listSource.indexOf('</TransitionGroup>', timelineStart);
  const timelineSource = listSource.slice(timelineStart, timelineEnd);
  assert.doesNotMatch(timelineSource, /\bcompact\b/);
  assert.match(listSource, /v-for="item in group\.items"[\s\S]*?\bcompact\b/);
});

test('timeline keeps scroll auto-paging; project view has no global load-more entry', () => {
  assert.match(listSource, /@scroll="handleScroll"/);
  assert.match(listSource, /function handleScroll\(\) \{\s*if \(props\.viewMode === 'project'\) return;/);
  assert.doesNotMatch(listSource, /session-load-more/);
  assert.doesNotMatch(listSource, /ChevronsDown/);
});

test('project groups render all loaded sessions without client-side reveal capping', () => {
  assert.doesNotMatch(listSource, /GROUP_REVEAL_STEP|GROUP_INITIAL_VISIBLE|groupVisibleLimits|visibleItems|hiddenCount/);
  assert.doesNotMatch(listSource, /显示更多/);
});

test('each project group pages from its own workspace cursor via the group button', () => {
  assert.match(listSource, /v-if="workspaceHasMore\(group\.id\)"/);
  assert.match(listSource, /loadingWorkspaceIds\[group\.id\]/);
  assert.match(listSource, /store\.loadWorkspace\(group\.id\)/);
  assert.match(listSource, />加载中…</);
  assert.match(listSource, /加载失败 · 点击重试/);
});

test('project group collapse reuses the execution-node height animation', () => {
  assert.match(listSource, /GroupCollapseBody/);
  assert.match(listSource, /:open="!isCollapsed\(group\.id\)"/);
});

test('project view first screen is seeded by the workspace preview endpoint', () => {
  assert.match(listSource, /store\.loadWorkspacePreview\(\)/);
  assert.match(listSource, /mode === 'project' && !loading/);
});
