import test from 'node:test';
import assert from 'node:assert/strict';

import { useEntityList } from './useEntityList.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('fetcher 返回数组:items 直填', async () => {
  const { items, refresh } = useEntityList(async () => [1, 2, 3], { immediate: false });
  await refresh();
  assert.deepEqual(items.value, [1, 2, 3]);
});

test('fetcher 返回 { items }:正确提取', async () => {
  const { items, refresh } = useEntityList(async () => ({ items: [{ a: 1 }], has_more: false }), { immediate: false });
  await refresh();
  assert.deepEqual(items.value, [{ a: 1 }]);
});

test('fetcher 返回 { data }:正确提取', async () => {
  const { items, refresh } = useEntityList(async () => ({ data: [9, 8] }), { immediate: false });
  await refresh();
  assert.deepEqual(items.value, [9, 8]);
});

test('immediate 默认 true:构造时即加载一次', async () => {
  let calls = 0;
  const list = useEntityList(async () => { calls += 1; return [1]; });
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(list.items.value, [1]);
});

test('immediate:false:构造时不加载', () => {
  let calls = 0;
  useEntityList(async () => { calls += 1; return []; }, { immediate: false });
  assert.equal(calls, 0);
});

test('失败:error 写入,items 保持空', async () => {
  const { items, error, refresh } = useEntityList(async () => {
    throw new Error('load fail');
  }, { immediate: false });
  await refresh();
  assert.equal(error.value, 'load fail');
  assert.deepEqual(items.value, []);
});

test('setItems 手动覆盖,空值兜底为 []', () => {
  const { items, setItems } = useEntityList(async () => [], { immediate: false });
  setItems([7]);
  assert.deepEqual(items.value, [7]);
  setItems(null);
  assert.deepEqual(items.value, []);
});

test('onSuccess 回调拿到 (items, rawResult)', async () => {
  let captured = null;
  useEntityList(
    async () => ({ items: [1], extra: 'meta' }),
    { immediate: false, onSuccess: (items, raw) => { captured = { items, raw }; } },
  ).refresh();
  await tick();
  assert.deepEqual(captured.items, [1]);
  assert.equal(captured.raw.extra, 'meta');
});
