import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeProviderTestResult } from './providerTestResult.js';

test('normalizes nested successful provider test responses', () => {
  assert.deepEqual(
    normalizeProviderTestResult({ response: { content: 'ok', error: null, latency: 0.12 } }),
    { content: 'ok', error: null, latency: 0.12 },
  );
});

test('preserves nested provider errors instead of treating them as success', () => {
  assert.deepEqual(
    normalizeProviderTestResult({ data: { content: null, error: 'invalid api key' } }),
    { content: null, error: 'invalid api key' },
  );
});
