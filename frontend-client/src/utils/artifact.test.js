import assert from 'node:assert/strict';
import test from 'node:test';

import { artifactAssetUrl, normalizeArtifactManifest } from './artifact.js';

test('normalizes a V2 chart presentation without viz_type', () => {
  const manifest = normalizeArtifactManifest({
    schema_version: 2,
    artifact_id: 'art_chart_1',
    kind: 'chart.echarts',
    subtype: 'line',
    title: 'Trend',
    assets: [],
    presentations: [{
      presentation_id: 'primary',
      surface: 'chart',
      renderer: 'chart.echarts',
      assets: {},
      config: { series: [{ type: 'line', data: [1, 2] }] },
    }],
  });

  assert.equal(manifest.displayKind, 'chart');
  assert.equal(manifest.config.series[0].type, 'line');
  assert.equal(manifest.kind, 'chart.echarts');
});

test('selects a V2 image Asset without a map Presentation', () => {
  const manifest = normalizeArtifactManifest({
    schema_version: 2,
    artifact_id: 'art_map_1',
    kind: 'map.raster',
    subtype: 'geotiff',
    title: 'Raster',
    assets: [{
      asset_id: 'preview',
      role: 'preview',
      filename: 'preview.png',
      media_type: 'image/png',
      size: 3,
      sha256: '0'.repeat(64),
      content_url: artifactAssetUrl('art_map_1', 'preview'),
    }],
    presentations: [],
    metadata: { spatial: { crs: 'EPSG:4326', bounds: [100, 20, 110, 30] } },
  });

  assert.equal(manifest.displayKind, 'image');
  assert.equal(manifest.primaryAsset.asset_id, 'preview');
  assert.equal(manifest.content_url, '/api/artifacts/art_map_1/assets/preview/content');
});

test('rejects the removed V1 artifact shape', () => {
  assert.throws(
    () => normalizeArtifactManifest({ artifact_id: 'art_old', viz_type: 'chart', config: {} }),
    /schema_version 2/,
  );
});
