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

test('workspace load replaces a stale unassigned selection with the first project', async () => {
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

  assert.equal(store.currentWorkspaceId, workspace.workspace_id);
  assert.equal(store.currentWorkspace?.display_name, 'ragsystem');
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
