import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick, ref } from 'vue';

import { useSessionRuntimeCenter } from './useSessionRuntimeCenter.js';

test('runtime center opens the requested mobile tab only on explicit actions', async () => {
  const wide = ref(false);
  const state = useSessionRuntimeCenter(wide);

  state.open('goal');
  assert.equal(state.activeTab.value, 'goal');
  assert.equal(state.mobileOpen.value, true);

  state.activeTab.value = 'background';
  assert.equal(state.activeTab.value, 'background');

  wide.value = true;
  await nextTick();
  assert.equal(state.mobileOpen.value, false);
  state.open('execution');
  assert.equal(state.activeTab.value, 'execution');
  assert.equal(state.mobileOpen.value, false);
});

