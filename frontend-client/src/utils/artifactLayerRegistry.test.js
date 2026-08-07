import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveArtifactLayer } from './artifactLayerRegistry.js';

const geojson = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { value: 1 },
    geometry: { type: 'Point', coordinates: [106.7, 23.1] },
  }],
};

function manifest(overrides = {}) {
  return {
    schema_version: 2,
    artifact_id: 'art_spatial_1',
    kind: 'vector.geojson',
    title: 'Spatial result',
    assets: [{
      asset_id: 'data',
      role: 'data',
      filename: 'result.geojson',
      media_type: 'application/geo+json',
    }],
    presentations: [],
    metadata: { spatial: { crs: 'EPSG:4326', bounds: [106, 22, 108, 24] } },
    ...overrides,
  };
}

test('resolves a GeoJSON Asset into a MapWorkspace descriptor', async () => {
  const resolved = await resolveArtifactLayer({ artifact_id: 'art_spatial_1' }, {
    getArtifact: async () => manifest(),
    getArtifactAssetContent: async () => ({ data: new Blob([JSON.stringify(geojson)]) }),
  });

  assert.equal(resolved.descriptor.type, 'geojson');
  assert.equal(resolved.descriptor.artifactId, 'art_spatial_1');
  assert.equal(resolved.descriptor.assetId, 'data');
  assert.deepEqual(resolved.descriptor.bounds, [106, 22, 108, 24]);
  assert.deepEqual(resolved.descriptor.source.data, geojson);
  assert.equal(resolved.resourceUrl, null);
});

test('resolves georeferenced image and raster tile metadata', async () => {
  const imageManifest = manifest({
    kind: 'raster.preview',
    assets: [{ asset_id: 'preview', role: 'preview', filename: 'preview.png', media_type: 'image/png' }],
  });
  const image = await resolveArtifactLayer({ artifact_id: 'art_spatial_1' }, {
    getArtifact: async () => imageManifest,
    getArtifactAssetContent: async () => ({ data: new Blob(['png']) }),
    createObjectURL: () => 'blob:preview',
  });
  assert.equal(image.descriptor.type, 'image');
  assert.equal(image.descriptor.source.url, 'blob:preview');
  assert.equal(image.resourceUrl, 'blob:preview');

  const tiles = await resolveArtifactLayer({ artifact_id: 'art_spatial_1' }, {
    getArtifact: async () => manifest({
      assets: [],
      metadata: {
        spatial: {
          crs: 'EPSG:4326',
          bounds: [100, 20, 110, 30],
          tiles: ['https://tiles.example/{z}/{x}/{y}.png'],
          tile_size: 256,
          min_zoom: 2,
          max_zoom: 14,
        },
      },
    }),
  });
  assert.equal(tiles.descriptor.type, 'raster');
  assert.deepEqual(tiles.descriptor.source.tiles, ['https://tiles.example/{z}/{x}/{y}.png']);
  assert.equal(tiles.descriptor.source.minzoom, 2);
  assert.equal(tiles.descriptor.source.maxzoom, 14);
});

test('rejects non-WGS84 or legacy flat spatial metadata', async () => {
  await assert.rejects(
    resolveArtifactLayer({ artifact_id: 'art_spatial_1' }, {
      getArtifact: async () => manifest({ metadata: { crs: 'EPSG:3857', bounds: [0, 0, 1, 1] } }),
    }),
    /metadata\.spatial/,
  );
  await assert.rejects(
    resolveArtifactLayer({ artifact_id: 'art_spatial_1' }, {
      getArtifact: async () => manifest({ metadata: { spatial: { crs: 'EPSG:3857', bounds: [0, 0, 1, 1] } } }),
    }),
    /只接受 WGS84/,
  );
});
