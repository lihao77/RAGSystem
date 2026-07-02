import test from 'node:test';
import assert from 'node:assert/strict';

import { useAsyncAction } from './useAsyncAction.js';
import { useToast } from './useToast.js';

const toast = useToast();
const toastState = toast.state;
function reset() {
  toast.hide();
}

test('成功:写入 data、清空 error、loading 复位,返回结果', async () => {
  reset();
  const { run, loading, error, data } = useAsyncAction(async () => 42);
  const promise = run();
  assert.equal(loading.value, true);
  const result = await promise;
  assert.equal(result, 42);
  assert.equal(data.value, 42);
  assert.equal(error.value, '');
  assert.equal(loading.value, false);
});

test('成功且给了 successMessage:弹 success toast', async () => {
  reset();
  const { run } = useAsyncAction(async () => 'ok', { successMessage: '保存成功' });
  await run();
  assert.equal(toastState.visible, true);
  assert.equal(toastState.message, '保存成功');
  assert.equal(toastState.type, 'success');
});

test('失败:写入 error、loading 复位、默认弹 error toast', async () => {
  reset();
  const { run, loading, error, data } = useAsyncAction(async () => {
    throw new Error('炸了');
  });
  const result = await run();
  assert.equal(result, undefined);
  assert.equal(error.value, '炸了');
  assert.equal(data.value, null);
  assert.equal(loading.value, false);
  assert.equal(toastState.visible, true);
  assert.equal(toastState.message, '炸了');
  assert.equal(toastState.type, 'error');
});

test('showErrorToast:false 时失败不弹 toast', async () => {
  reset();
  const { run } = useAsyncAction(async () => {
    throw new Error('quiet');
  }, { showErrorToast: false });
  await run();
  assert.equal(toastState.visible, false);
});

test('失败且无 e.message 时用 errorPrefix 兜底', async () => {
  reset();
  const action = useAsyncAction(async () => { throw {}; }, { errorPrefix: '加载失败', showErrorToast: false });
  await action.run();
  assert.equal(action.error.value, '加载失败');
});

test('透传 run 参数', async () => {
  reset();
  const seen = [];
  const { run } = useAsyncAction(async (a, b) => {
    seen.push([a, b]);
    return a + b;
  }, { showErrorToast: false });
  const r = await run(2, 3);
  assert.equal(r, 5);
  assert.deepEqual(seen, [[2, 3]]);
});

test('onSuccess/onError 回调被触发', async () => {
  reset();
  let okVal = null;
  let errVal = null;
  const a = useAsyncAction(async (x) => x * 2, { onSuccess: (r) => { okVal = r; } });
  await a.run(3);
  assert.equal(okVal, 6);

  const b = useAsyncAction(async () => {
    throw new Error('e');
  }, { onError: (e) => { errVal = e; }, showErrorToast: false });
  await b.run();
  assert.ok(errVal instanceof Error);
  assert.equal(errVal.message, 'e');
});

test('reset 清空 error/data', async () => {
  reset();
  const { run, reset: resetAction, data, error } = useAsyncAction(async () => 'X', { showErrorToast: false });
  await run();
  assert.equal(data.value, 'X');
  resetAction();
  assert.equal(data.value, null);
  assert.equal(error.value, '');
});
