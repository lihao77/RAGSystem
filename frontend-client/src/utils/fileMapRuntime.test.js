import assert from 'node:assert/strict';
import test from 'node:test';

import { bindFileMapRuntime, callFileMapRuntime, getFileMapRuntime } from './fileMapRuntime.js';

test('binds one active file map controller and routes calls', async () => {
  const controller = { listLayers: () => ({ layers: [] }) };
  const unbind = bindFileMapRuntime(controller);
  assert.equal(getFileMapRuntime(), controller);
  assert.deepEqual(await callFileMapRuntime('listLayers'), { layers: [] });
  unbind();
  assert.equal(getFileMapRuntime(), null);
});
