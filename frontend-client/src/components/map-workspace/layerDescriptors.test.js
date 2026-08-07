import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundsToImageCoordinates,
  buildMapLibreLayerBundle,
  thematicColorExpression,
  combineLayerBounds,
  moveLayerDescriptor,
  normalizeLayerDescriptor,
} from './layerDescriptors.js';

const polygon = {
  type: 'Feature',
  properties: { name: 'area' },
  geometry: {
    type: 'Polygon',
    coordinates: [[[106, 22], [109, 22], [109, 24], [106, 24], [106, 22]]],
  },
};

test('normalizes GeoJSON layers and clamps presentation state', () => {
  const layer = normalizeLayerDescriptor({
    id: 'art_vector_1',
    type: 'geojson',
    source: { data: polygon },
    opacity: 4,
  });

  assert.equal(layer.name, 'art_vector_1');
  assert.equal(layer.opacity, 1);
  assert.equal(layer.source.generateId, true);
  assert.equal(layer.style.fillOpacity, 0.28);
});

test('converts a canonical WGS84 bbox to MapLibre image coordinates', () => {
  assert.deepEqual(
    boundsToImageCoordinates([100, 20, 110, 30]),
    [[100, 30], [110, 30], [110, 20], [100, 20]],
  );
});

test('requires image bounds and raster tile templates', () => {
  assert.throws(
    () => normalizeLayerDescriptor({ id: 'image', type: 'image', source: { url: '/image.png' } }),
    /require WGS84 bounds/,
  );
  assert.throws(
    () => normalizeLayerDescriptor({ id: 'tiles', type: 'raster', source: { tiles: [] } }),
    /source.tiles/,
  );
});

test('builds MapLibre source and geometry layers without legacy render config', () => {
  const bundle = buildMapLibreLayerBundle({
    id: 'vector',
    type: 'geojson',
    source: { data: polygon },
    opacity: 0.5,
    style: { fillOpacity: 0.4 },
  });

  assert.equal(bundle.source.type, 'geojson');
  assert.deepEqual(bundle.layers.map((layer) => layer.type), ['fill', 'line', 'circle']);
  assert.equal(bundle.layers[0].paint['fill-opacity'], 0.2);
  assert.equal('config' in bundle, false);
});

test('builds categorical and continuous thematic color expressions', () => {
  const categorical = normalizeLayerDescriptor({
    id: 'risk',
    type: 'geojson',
    source: { data: polygon },
    style: {
      thematic: {
        field: 'risk_level',
        method: 'categorical',
        stops: [{ value: 'high', color: '#dc2626', label: '高' }],
        defaultColor: '#94a3b8',
      },
    },
  });
  assert.deepEqual(thematicColorExpression(categorical.style.thematic), [
    'match', ['get', 'risk_level'], 'high', '#dc2626', '#94a3b8',
  ]);

  const continuous = normalizeLayerDescriptor({
    id: 'value',
    type: 'geojson',
    source: { data: polygon },
    style: {
      thematic: {
        field: 'value',
        method: 'interpolate',
        stops: [{ value: 100, color: '#fee2e2' }, { value: 0, color: '#166534' }],
      },
    },
  });
  assert.deepEqual(continuous.style.thematic.stops.map((stop) => stop.value), [0, 100]);
  assert.deepEqual(thematicColorExpression(continuous.style.thematic), [
    'interpolate', ['linear'], ['to-number', ['get', 'value']], 0, '#166534', 100, '#fee2e2',
  ]);
});

test('combines explicit and inferred bounds and moves layers immutably', () => {
  const layers = [
    { id: 'vector', type: 'geojson', source: { data: polygon } },
    { id: 'image', type: 'image', source: { url: '/image.png' }, bounds: [90, 10, 100, 20] },
  ];

  assert.deepEqual(combineLayerBounds(layers), [90, 10, 109, 24]);
  const moved = moveLayerDescriptor(layers, 'image', 0);
  assert.deepEqual(moved.map((layer) => layer.id), ['image', 'vector']);
  assert.deepEqual(layers.map((layer) => layer.id), ['vector', 'image']);
});

test('keeps degenerate GeoJSON bounds so point layers can be fitted', () => {
  const point = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: [108.3, 22.8] },
  };
  const layers = [{ id: 'point', type: 'geojson', source: { data: point } }];

  assert.deepEqual(combineLayerBounds(layers), [108.3, 22.8, 108.3, 22.8]);
});
