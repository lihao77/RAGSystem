import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, ref } from 'vue';
import { useClampedExpand } from './useClampedExpand.js';

/** 假 DOM 元素：只承载 composable 触碰的表面（style + 高度读数）。 */
function makeEl({ scrollHeight, offsetHeight = 0 }) {
  return { style: {}, scrollHeight, offsetHeight };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 挂元素后等 elRef watch（flush: post）与 expanded watch 的 nextTick 都落地。 */
async function settle() {
  await nextTick();
  await nextTick();
}

test('内容超高时钉住钳高并报 clampable；不超高则无内联上限', async () => {
  const scope = effectScope();

  const tallRef = ref(null);
  let tall;
  scope.run(() => { tall = useClampedExpand(tallRef, { clamp: 280 }); });
  tallRef.value = makeEl({ scrollHeight: 600, offsetHeight: 280 });
  await settle();
  assert.equal(tall.clampable.value, true);
  assert.equal(tallRef.value.style.maxHeight, '280px');

  const shortRef = ref(null);
  let short;
  scope.run(() => { short = useClampedExpand(shortRef, { clamp: 280 }); });
  shortRef.value = makeEl({ scrollHeight: 200, offsetHeight: 200 });
  await settle();
  assert.equal(short.clampable.value, false);
  assert.equal(shortRef.value.style.maxHeight, '');

  scope.stop();
});

test('贴着钳高（容差内）不折叠，避免临界值闪按钮', async () => {
  const scope = effectScope();
  const elRef = ref(null);
  let api;
  scope.run(() => { api = useClampedExpand(elRef, { clamp: 280 }); });
  elRef.value = makeEl({ scrollHeight: 280 + 8, offsetHeight: 280 });
  await settle();
  assert.equal(api.clampable.value, false);
  scope.stop();
});

test('展开：过渡到实测全高后释放上限；收起：从 none 先钉可视高再回钳值', async () => {
  const scope = effectScope();
  const el = makeEl({ scrollHeight: 600, offsetHeight: 280 });
  const elRef = ref(null);
  let api;
  scope.run(() => { api = useClampedExpand(elRef, { clamp: 280, releaseDelay: 10 }); });
  elRef.value = el;
  await settle();
  assert.equal(el.style.maxHeight, '280px');

  api.toggle();
  await settle();
  assert.equal(el.style.maxHeight, '600px');
  await sleep(20);
  assert.equal(el.style.maxHeight, 'none');

  api.toggle();
  await settle();
  assert.equal(el.style.maxHeight, '280px');
  scope.stop();
});

test('元素重挂载时保持展开态：直接释放上限，不回钳值', async () => {
  const scope = effectScope();
  const elRef = ref(null);
  let api;
  scope.run(() => { api = useClampedExpand(elRef, { clamp: 280, releaseDelay: 10 }); });
  elRef.value = makeEl({ scrollHeight: 600, offsetHeight: 280 });
  await settle();
  api.toggle();
  await settle();
  await sleep(20);

  elRef.value = makeEl({ scrollHeight: 620, offsetHeight: 620 });
  await settle();
  assert.equal(api.expanded.value, true);
  assert.equal(elRef.value.style.maxHeight, 'none');
  scope.stop();
});
