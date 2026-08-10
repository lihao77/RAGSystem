import test from 'node:test';
import assert from 'node:assert/strict';
import { useSessionRuntimeCenter } from './useSessionRuntimeCenter.js';

test('runtime center stays closed until explicitly opened', () => {
  const state = useSessionRuntimeCenter();

  assert.equal(state.isOpen.value, false);

  state.open();
  assert.equal(state.isOpen.value, true);

  state.close();
  assert.equal(state.isOpen.value, false);
});
