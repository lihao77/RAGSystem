import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindArtifactMapRuntime,
  callArtifactMapRuntime,
  getArtifactMapRuntime,
} from './artifactMapRuntime.js';

test('binds one active map controller and routes tool calls', async () => {
  const controller = {
    listLayers: () => ({ layers: [{ layer_id: 'layer-1' }] }),
  };
  const unbind = bindArtifactMapRuntime(controller);
  try {
    assert.equal(getArtifactMapRuntime(), controller);
    assert.deepEqual(await callArtifactMapRuntime('listLayers'), { layers: [{ layer_id: 'layer-1' }] });
    await assert.rejects(callArtifactMapRuntime('missing'), /不支持操作/);
  } finally {
    unbind();
  }
  assert.equal(getArtifactMapRuntime(), null);
  await assert.rejects(callArtifactMapRuntime('listLayers'), /没有可用的地图工作台/);
});
