import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';

import { UNASSIGNED_WORKSPACE_ID, useWorkspaceStore } from './workspace.js';

const workspace = {
  workspace_id: 'workspace-1',
  display_name: 'ragsystem',
  root_path: 'D:/python/ragsystem',
  session_count: 3,
};

test('workspace load restores a persisted unassigned selection', async () => {
  localStorage.clear();
  localStorage.setItem('ragsystem:current-workspace', UNASSIGNED_WORKSPACE_ID);
  setActivePinia(createPinia());
  const store = useWorkspaceStore();
  store.setClient({
    async listWorkspaces() {
      return { data: { items: [workspace] } };
    },
  });

  await store.load();

  assert.equal(store.currentWorkspaceId, UNASSIGNED_WORKSPACE_ID);
  assert.equal(store.currentWorkspace, null);
  assert.equal(localStorage.getItem('ragsystem:current-workspace'), UNASSIGNED_WORKSPACE_ID);
});

test('workspace clear preserves the persisted project selection', async () => {
  localStorage.clear();
  setActivePinia(createPinia());
  const store = useWorkspaceStore();
  store.setClient({
    async listWorkspaces() {
      return { data: { items: [workspace] } };
    },
  });
  await store.load();

  store.clear();

  assert.equal(store.currentWorkspaceId, null);
  assert.equal(localStorage.getItem('ragsystem:current-workspace'), workspace.workspace_id);
});

test('workspace removal hides the project and keeps a valid selection', async () => {
  localStorage.clear();
  setActivePinia(createPinia());
  const removed = [];
  const store = useWorkspaceStore();
  store.setClient({
    async listWorkspaces() {
      return { data: { items: [workspace, { ...workspace, workspace_id: 'workspace-2', display_name: 'second' }] } };
    },
    async removeWorkspace(workspaceId) {
      removed.push(workspaceId);
      return { success: true };
    },
  });
  await store.load();

  await store.remove(workspace.workspace_id);

  assert.deepEqual(removed, [workspace.workspace_id]);
  assert.deepEqual(store.items.map(item => item.workspace_id), ['workspace-2']);
  assert.equal(store.currentWorkspaceId, 'workspace-2');
  assert.equal(localStorage.getItem('ragsystem:current-workspace'), 'workspace-2');
});

test('workspace rename updates the item in place and keeps selection stable', async () => {
  localStorage.clear();
  setActivePinia(createPinia());
  const renamed = [];
  const second = { ...workspace, workspace_id: 'workspace-2', display_name: 'aaa-second' };
  const store = useWorkspaceStore();
  store.setClient({
    async listWorkspaces() {
      return { data: { items: [workspace, second] } };
    },
    async updateWorkspace(workspaceId, displayName) {
      renamed.push({ workspaceId, displayName });
      return { data: { workspace_id: workspaceId, display_name: displayName, root_path: workspace.root_path } };
    },
  });
  await store.load();

  const result = await store.rename(workspace.workspace_id, 'zzz-renamed');

  assert.deepEqual(renamed, [{ workspaceId: workspace.workspace_id, displayName: 'zzz-renamed' }]);
  assert.equal(result.display_name, 'zzz-renamed');
  // 列表按名称重排序，且本地 session_count 保留
  assert.deepEqual(store.items.map(item => item.display_name), ['aaa-second', 'zzz-renamed']);
  assert.equal(store.items.find(item => item.display_name === 'zzz-renamed').session_count, 3);
  // 重命名不改变当前选中（load 后默认选中列表第一项 workspace-1）
  assert.equal(store.currentWorkspaceId, 'workspace-1');

  await assert.rejects(
    () => store.rename(workspace.workspace_id, '   '),
    /项目名称不能为空/,
  );
});

test('workspace reorder persists a custom order and load restores it', async () => {
  localStorage.clear();
  setActivePinia(createPinia());
  const first = { ...workspace, workspace_id: 'workspace-a', display_name: 'aaa' };
  const second = { ...workspace, workspace_id: 'workspace-b', display_name: 'bbb' };
  const third = { ...workspace, workspace_id: 'workspace-c', display_name: 'ccc' };
  const loadStore = async () => {
    const store = useWorkspaceStore();
    store.setClient({
      async listWorkspaces() {
        return { data: { items: [first, second, third] } };
      },
    });
    await store.load();
    return store;
  };

  let store = await loadStore();
  store.reorder([third.workspace_id, first.workspace_id, second.workspace_id]);
  assert.deepEqual(store.items.map(item => item.workspace_id), ['workspace-c', 'workspace-a', 'workspace-b']);
  assert.deepEqual(
    JSON.parse(localStorage.getItem('ragsystem:workspace-order')),
    ['workspace-c', 'workspace-a', 'workspace-b'],
  );

  // 刷新后 load 按持久化顺序恢复
  store = await loadStore();
  assert.deepEqual(store.items.map(item => item.workspace_id), ['workspace-c', 'workspace-a', 'workspace-b']);

  // 自定义顺序下：新建追加到末尾，重命名保持位置
  store.setClient({
    async listWorkspaces() { return { data: { items: [first, second, third] } }; },
    async createWorkspace() { return { data: { workspace_id: 'workspace-d', display_name: 'ddd', root_path: 'D:/ddd' } }; },
    async updateWorkspace(id, displayName) { return { data: { workspace_id: id, display_name: displayName, root_path: 'D:/x' } }; },
  });
  await store.create('D:/ddd');
  assert.equal(store.items.at(-1).workspace_id, 'workspace-d');
  await store.rename('workspace-c', 'zzz');
  assert.equal(store.items[0].workspace_id, 'workspace-c');
  assert.equal(store.items[0].display_name, 'zzz');

  // reorder 收敛缺失/未知 id：未知忽略，缺失项保持相对顺序垫底
  store.reorder(['workspace-a', 'nope', 'workspace-d']);
  assert.deepEqual(store.items.map(item => item.workspace_id), ['workspace-a', 'workspace-d', 'workspace-c', 'workspace-b']);
});

test('workspace without custom order keeps name sorting on create and rename', async () => {
  localStorage.clear();
  setActivePinia(createPinia());
  const store = useWorkspaceStore();
  const first = { ...workspace, workspace_id: 'workspace-a', display_name: 'aaa' };
  const second = { ...workspace, workspace_id: 'workspace-b', display_name: 'bbb' };
  store.setClient({
    async listWorkspaces() { return { data: { items: [second, first] } }; },
    async createWorkspace() { return { data: { workspace_id: 'workspace-c', display_name: 'ccc', root_path: 'D:/ccc' } }; },
    async updateWorkspace(id, displayName) { return { data: { workspace_id: id, display_name: displayName, root_path: 'D:/x' } }; },
  });
  await store.load();
  await store.create('D:/ccc');
  assert.deepEqual(store.items.map(item => item.display_name), ['aaa', 'bbb', 'ccc']);
  await store.rename('workspace-c', '000');
  assert.deepEqual(store.items.map(item => item.display_name), ['000', 'aaa', 'bbb']);
  assert.equal(localStorage.getItem('ragsystem:workspace-order'), null);
});

test('workspace collapse state toggles and persists', async () => {
  localStorage.clear();
  setActivePinia(createPinia());
  const store = useWorkspaceStore();
  store.setClient({
    async listWorkspaces() { return { data: { items: [workspace] } }; },
  });
  await store.load();

  assert.equal(store.isCollapsed(workspace.workspace_id), false);
  store.toggleCollapsed(workspace.workspace_id);
  assert.equal(store.isCollapsed(workspace.workspace_id), true);
  store.toggleCollapsed(workspace.workspace_id);
  assert.equal(store.isCollapsed(workspace.workspace_id), false);
  store.toggleCollapsed(workspace.workspace_id);
  assert.deepEqual(JSON.parse(localStorage.getItem('ragsystem:workspace-collapsed')), [workspace.workspace_id]);
});
