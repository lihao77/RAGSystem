import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, ref, watch } from 'vue';
import { useAuthenticatedImageSource } from './useAuthenticatedImageSource.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function setup(t) {
  const source = ref('/api/one.png');
  const requests = new Map();
  const decodes = new Map();
  const releases = [];
  const errors = [];
  const ready = [];
  const scope = effectScope();
  const state = scope.run(() => useAuthenticatedImageSource(source, {
    retainWhileLoading: true,
    resolveMedia: (url, { signal }) => {
      const request = { ...deferred(), signal };
      requests.set(url, request);
      return request.promise;
    },
    decode: (url) => {
      const decoding = deferred();
      decodes.set(url, decoding);
      return decoding.promise;
    },
    onError: error => errors.push(error),
    onReady: () => ready.push(source.value),
  }));
  t.after(() => scope.stop());
  const deliver = async (url) => {
    requests.get(url).resolve({ src: `blob:${url}`, release: () => releases.push(url) });
    await flush();
  };
  const display = async (url) => {
    await deliver(url);
    decodes.get(`blob:${url}`).resolve();
    await flush();
  };
  return { source, requests, decodes, releases, errors, ready, scope, ...state, deliver, display };
}

test('切图期间保留旧图及其资源，下载并解码完成后一次替换', async t => {
  const state = setup(t);
  await state.display('/api/one.png');
  const changes = [];
  const stop = watch(state.resolvedSrc, value => changes.push(value), { flush: 'sync' });
  t.after(stop);
  state.source.value = '/api/two.png';
  await nextTick();
  assert.equal(state.loading.value, true);
  assert.equal(state.resolvedSrc.value, 'blob:/api/one.png');
  assert.deepEqual(state.releases, []);
  await state.deliver('/api/two.png');
  assert.equal(state.resolvedSrc.value, 'blob:/api/one.png');
  assert.deepEqual(state.ready, ['/api/one.png']);
  assert.deepEqual(state.releases, []);
  state.decodes.get('blob:/api/two.png').resolve();
  await flush();
  assert.deepEqual(changes, ['blob:/api/two.png']);
  assert.deepEqual(state.ready, ['/api/one.png', '/api/two.png']);
  assert.deepEqual(state.releases, ['/api/one.png']);
  assert.equal(state.loading.value, false);
});

test('快速切图中迟到的下载不会覆盖最新图片，并释放迟到资源', async t => {
  const state = setup(t);
  state.source.value = '/api/two.png';
  await nextTick();
  assert.equal(state.requests.get('/api/one.png').signal.aborted, true);
  await state.display('/api/two.png');
  await state.deliver('/api/one.png');
  assert.equal(state.resolvedSrc.value, 'blob:/api/two.png');
  assert.deepEqual(state.ready, ['/api/two.png']);
  assert.deepEqual(state.releases, ['/api/one.png']);
  assert.equal(state.decodes.has('blob:/api/one.png'), false);
});

test('快速切图中迟到的解码不会覆盖最新图片', async t => {
  const state = setup(t);
  await state.deliver('/api/one.png');
  state.source.value = '/api/two.png';
  await nextTick();
  await state.display('/api/two.png');
  state.decodes.get('blob:/api/one.png').resolve();
  await flush();
  assert.equal(state.resolvedSrc.value, 'blob:/api/two.png');
  assert.deepEqual(state.releases, ['/api/one.png']);
  assert.equal(state.loading.value, false);
});

test('加载或解码失败保留旧图，回收新资源并报告错误', async t => {
  const state = setup(t);
  await state.display('/api/one.png');
  state.source.value = '/api/two.png';
  await nextTick();
  state.requests.get('/api/two.png').reject(new Error('download failed'));
  await flush();
  assert.equal(state.resolvedSrc.value, 'blob:/api/one.png');
  assert.deepEqual(state.releases, []);
  state.source.value = '/api/three.png';
  await nextTick();
  await state.deliver('/api/three.png');
  state.decodes.get('blob:/api/three.png').reject(new Error('decode failed'));
  await flush();
  assert.equal(state.resolvedSrc.value, 'blob:/api/one.png');
  assert.deepEqual(state.releases, ['/api/three.png']);
  assert.equal(state.errors.length, 2);
  assert.equal(state.loading.value, false);
});

test('关闭预览回收当前及迟到资源，解码完成后不会再发布图片', async t => {
  const state = setup(t);
  await state.display('/api/one.png');
  state.source.value = '/api/two.png';
  await nextTick();
  await state.deliver('/api/two.png');
  state.scope.stop();
  assert.deepEqual(state.releases, ['/api/one.png']);
  assert.equal(state.requests.get('/api/two.png').signal.aborted, true);
  state.decodes.get('blob:/api/two.png').resolve();
  await flush();
  assert.equal(state.resolvedSrc.value, '');
  assert.deepEqual(state.releases, ['/api/one.png', '/api/two.png']);
});

test('普通图片保持原有直连行为，不进行额外解码；空来源清理视图', async t => {
  const scope = effectScope();
  t.after(() => scope.stop());
  const source = ref('blob:local-one');
  const state = scope.run(() => useAuthenticatedImageSource(source, {
    decode: () => assert.fail('direct image should not be decoded offscreen'),
  }));
  assert.equal(state.resolvedSrc.value, 'blob:local-one');
  assert.equal(state.loading.value, false);
  source.value = 'blob:local-two';
  await nextTick();
  assert.equal(state.resolvedSrc.value, 'blob:local-two');
  source.value = '';
  await nextTick();
  assert.equal(state.resolvedSrc.value, '');
});
