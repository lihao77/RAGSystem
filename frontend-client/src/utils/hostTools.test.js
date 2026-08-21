import assert from 'node:assert/strict';
import test from 'node:test';

import { getHostTool, getHostToolDeclarations } from './hostTools.js';

test('declares only the client environment host tool', () => {
  const names = getHostToolDeclarations().map((tool) => tool.name);
  assert.deepEqual(names, ['get_client_env']);
});

test('get_client_env reports browser environment', async () => {
  const result = await getHostTool('get_client_env').execute();
  assert.equal(result.ok, true);
  assert.match(result.observation, /"language"/);
  assert.match(result.observation, /"timezone"/);
});

test('returns null for unknown tools', () => {
  assert.equal(getHostTool('map_add_file_layer'), null);
  assert.equal(getHostTool('does_not_exist'), null);
});
