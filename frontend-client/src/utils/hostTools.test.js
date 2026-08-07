import assert from 'node:assert/strict';
import test from 'node:test';

import { bindFileMapRuntime } from './fileMapRuntime.js';
import { getHostTool, getHostToolDeclarations } from './hostTools.js';

test('declares the tool-driven MapLibre workspace API', () => {
  const names = getHostToolDeclarations().map((tool) => tool.name);
  assert.deepEqual(names.filter((name) => name.startsWith('map_')), [
    'map_add_file_layer',
    'map_set_layer_style',
    'map_remove_layer',
    'map_list_layers',
    'map_set_layer_visibility',
    'map_set_layer_opacity',
    'map_reorder_layer',
    'map_fit_layer',
    'map_clear_layers',
    'map_get_viewport',
    'map_set_viewport',
  ]);
});

test('returns compact map observations without serializing layer data', async () => {
  const unbind = bindFileMapRuntime({
    setLayerVisibility: ({ layer_id, visible }) => ({ layer_id, visible }),
    setLayerOpacity: ({ layer_id, opacity }) => ({ layer_id, opacity }),
  });
  try {
    const visibility = await getHostTool('map_set_layer_visibility').execute({ layer_id: 'layer-1', visible: false });
    const opacity = await getHostTool('map_set_layer_opacity').execute({ layer_id: 'layer-1', opacity: 0.4 });
    assert.deepEqual(visibility.structured, { layer_id: 'layer-1', visible: false });
    assert.deepEqual(opacity.structured, { layer_id: 'layer-1', opacity: 0.4 });
    assert.doesNotMatch(visibility.observation, /coordinates|FeatureCollection|geometry/);
    assert.doesNotMatch(opacity.observation, /coordinates|FeatureCollection|geometry/);
  } finally {
    unbind();
  }
});
