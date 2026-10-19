import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { useMessageWindow } from './useMessageWindow.js';

test('windowing is opt-in, pins editors, resets per conversation, and cleans up observers', async () => {
  const previous = Object.fromEntries(['window', 'document', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle'].map(key => [key, globalThis[key]]));
  const frames = new Map();
  const listeners = new Map();
  let serial = 0;
  let disconnected = 0;
  globalThis.window = { addEventListener: key => listeners.set(key, true), removeEventListener: key => listeners.delete(key) };
  globalThis.document = { activeElement: null };
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() { disconnected += 1; } };
  globalThis.requestAnimationFrame = callback => { frames.set(++serial, callback); return serial; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.getComputedStyle = () => ({ marginTop: '0' });
  const scope = effectScope();
  const rows = ref(Array.from({ length: 1000 }, (_, index) => ({ key: `m${index}`, msg: { id: `m${index}` } })));
  const container = shallowRef(null);
  const editingMessage = ref(null);
  const contextKey = ref('a');
  const host = {
    style: { overflowAnchor: 'auto', scrollBehavior: '' }, scrollTop: 0, scrollHeight: 112000, clientHeight: 800,
    getBoundingClientRect: () => ({ top: 0 }),
    addEventListener: key => listeners.set(`host:${key}`, true), removeEventListener: key => listeners.delete(`host:${key}`),
  };
  let view;
  try {
    view = scope.run(() => useMessageWindow({ rows, container, editingMessage, contextKey, following: ref(false),
      stream: shallowRef({ clientWidth: 700, getBoundingClientRect: () => ({ top: -host.scrollTop }) }) }));
    await nextTick();
    assert.equal(view.active.value, false);
    assert.equal(view.entries.value.length, 1000);
    container.value = host;
    await nextTick();
    assert.equal(view.active.value, true);
    assert.equal(host.style.overflowAnchor, 'none');
    assert.ok(view.entries.value.length < 30);
    editingMessage.value = rows.value[600].msg;
    assert.ok(view.entries.value.some(entry => entry.index === 600));
    editingMessage.value = null;
    assert.ok(!view.entries.value.some(entry => entry.index === 600));
    view.showAll.value = true;
    await nextTick();
    assert.equal(view.entries.value.length, 1000);
    assert.equal(host.style.overflowAnchor, 'auto');
    contextKey.value = 'b';
    rows.value = rows.value.slice(0, 20);
    await nextTick();
    assert.equal(view.showAll.value, false);
    assert.equal(view.active.value, false);
    assert.equal(view.entries.value.length, 20);
    // Crossing the threshold primes real heights instead of moving an existing reader
    // to an offset calculated from estimates.
    contextKey.value = 'c';
    rows.value = Array.from({ length: 199 }, (_, index) => ({ key: `m${index}`, msg: { id: `m${index}` } }));
    await nextTick();
    host.scrollTop = 2500;
    rows.value.forEach((row, index) => view.bindRow(row.key)({
      nodeType: 1, isConnected: true,
      getBoundingClientRect: () => ({ top: index * 50 - host.scrollTop, bottom: (index + 1) * 50 - host.scrollTop, height: 50 }),
      querySelector: () => null, contains: () => false,
    }));
    rows.value = [...rows.value, { key: 'm199', msg: {} }, { key: 'm200', msg: {} }];
    await nextTick();
    await nextTick();
    assert.equal(view.active.value, true);
    assert.equal(host.scrollTop, 2500);
    assert.equal(await view.scrollToMessage('missing'), null);
  } finally {
    scope.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
  assert.equal(frames.size, 0);
  assert.equal(listeners.size, 0);
  assert.ok(disconnected > 0);
});
