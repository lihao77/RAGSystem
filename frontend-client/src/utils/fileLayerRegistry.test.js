import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveFileLayer } from './fileLayerRegistry.js';

test('resolves a workspace GeoJSON file into a map descriptor', async () => {
  const geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [108, 23] } }] };
  const resolved = await resolveFileLayer({ file_path: 'results/points.geojson', session_id: 'session-1' }, {
    getWorkspaceFileContent: async () => ({ data: new Blob([JSON.stringify(geojson)]) }),
  });
  assert.equal(resolved.descriptor.filePath, 'results/points.geojson');
  assert.equal(resolved.descriptor.type, 'geojson');
  assert.deepEqual(resolved.descriptor.bounds, [108, 23, 108, 23]);
});

test('rejects paths outside the workspace', async () => {
  await assert.rejects(resolveFileLayer({ file_path: '../outside.geojson', session_id: 'session-1' }), /不能包含/);
});
