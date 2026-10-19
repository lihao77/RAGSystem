import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageLayout, messageIndexAt, messageWindowEntries } from './messageWindow.js';

test('empty history and offsets at either boundary are safe', () => {
  assert.deepEqual(messageWindowEntries(createMessageLayout([], new Map()), 0, 800), []);
  const layout = createMessageLayout(['a', 'b', 'c'], new Map([['b', 200]]), 100);
  assert.deepEqual(layout.offsets, [0, 100, 300, 400]);
  assert.equal(messageIndexAt(layout, -1), 0);
  assert.equal(messageIndexAt(layout, 100), 1);
  assert.equal(messageIndexAt(layout, 299), 1);
  assert.equal(messageIndexAt(layout, 999), 2);
});

test('disjoint pins retain ordering and total height without duplicate rows', () => {
  const layout = createMessageLayout(Array.from({ length: 100 }, (_, i) => `m${i}`), new Map(), 100);
  const entries = messageWindowEntries(layout, 4000, 4200, [0, 40, 80, 99, 99, -1, 100]);
  assert.deepEqual(entries.filter(e => e.index !== undefined).map(e => e.index), [0, 40, 41, 42, 80, 99]);
  assert.equal(entries.reduce((height, e) => height + (e.height ?? 100), 0), layout.total);
  assert.equal(new Set(entries.map(e => e.key)).size, entries.length);
});

test('keyed heights survive prepend, reorder, and dynamic height changes', () => {
  const sizes = new Map([['a', 30], ['b', 200], ['c', 50]]);
  assert.deepEqual(createMessageLayout(['a', 'b', 'c'], sizes).offsets, [0, 30, 230, 280]);
  sizes.set('b', 500);
  assert.deepEqual(createMessageLayout(['new', 'c', 'a', 'b'], sizes, 100).offsets, [0, 100, 150, 180, 680]);
});

test('5000 messages mount a bounded window including the streaming tail and edited row', () => {
  const layout = createMessageLayout(Array.from({ length: 5000 }, (_, i) => `m${i}`), new Map());
  for (const offset of [0, 100_000, 300_000, layout.total]) {
    const entries = messageWindowEntries(layout, offset, offset + 2700, [12, 4998, 4999]);
    const mounted = entries.filter(e => e.index !== undefined);
    assert.ok(mounted.length < 30);
    assert.ok(mounted.some(e => e.index === 12));
    assert.ok(mounted.some(e => e.index === 4999));
    assert.equal(entries.reduce((height, e) => height + (e.height ?? 112), 0), layout.total);
  }
});
