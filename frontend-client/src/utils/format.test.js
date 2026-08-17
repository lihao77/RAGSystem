import assert from 'node:assert/strict';
import test from 'node:test';

import { formatTokenCount } from './format.js';

test('formatTokenCount formats sub-thousand values as-is', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(42), '42');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(999.6), '1000');
});

test('formatTokenCount formats thousands with one-decimal trimming', () => {
  assert.equal(formatTokenCount(1000), '1k');
  assert.equal(formatTokenCount(1234), '1.2k');
  assert.equal(formatTokenCount(1500), '1.5k');
  assert.equal(formatTokenCount(999_949), '999.9k');
});

test('formatTokenCount promotes to m at the rounding boundary instead of showing 1000k', () => {
  assert.equal(formatTokenCount(999_950), '1m');
  assert.equal(formatTokenCount(1_000_000), '1m');
  assert.equal(formatTokenCount(2_500_000), '2.5m');
});

test('formatTokenCount guards non-finite and negative input', () => {
  assert.equal(formatTokenCount(Number.NaN), '0');
  assert.equal(formatTokenCount(Number.POSITIVE_INFINITY), '0');
  assert.equal(formatTokenCount(-5), '0');
  assert.equal(formatTokenCount('abc'), '0');
  assert.equal(formatTokenCount('1234'), '1.2k');
});
