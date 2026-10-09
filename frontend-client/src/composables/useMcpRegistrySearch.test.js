import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { useMcpRegistryAutoSearch, useMcpRegistrySearch } from './useMcpRegistrySearch.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(t) {
  const query = reactive({ query: 'old', latest_only: true, limit: 6 });
  const requests = [];
  const errors = [];
  const state = useMcpRegistrySearch({
    query,
    fetchPage: (params) => {
      const request = deferred();
      requests.push({ params, ...request });
      return request.promise;
    },
    onError: (message) => errors.push(message),
  });
  t.after(state.dispose);
  return { query, requests, errors, ...state };
}

function page(names, next_cursor = '') {
  return { data: { items: names.map((name) => ({ name, version: '1' })), next_cursor } };
}

test('慢的旧查询不能覆盖最新结果和游标', async (t) => {
  const h = harness(t);
  const old = h.run();
  h.query.query = 'new';
  const latest = h.run();
  assert.deepEqual(h.requests[1].params, { search: 'new', limit: 6, latest_only: true, cursor: '' });
  h.requests[1].resolve(page(['new'], 'new-cursor'));
  await latest;
  h.requests[0].resolve(page(['old'], 'old-cursor'));
  await old;
  assert.deepEqual(h.results.value.map((item) => item.name), ['new']);
  assert.equal(h.nextCursor.value, 'new-cursor');
  assert.equal(h.loading.value, false);
});

test('旧请求先完成时仍保留新请求的 loading,过期错误不通知用户', async (t) => {
  const h = harness(t);
  const old = h.run();
  const latest = h.run();
  h.requests[0].reject(new Error('stale failure'));
  await old;
  assert.equal(h.loading.value, true);
  assert.equal(h.error.value, '');
  assert.deepEqual(h.errors, []);
  h.requests[1].resolve(page(['latest']));
  await latest;
  assert.equal(h.loading.value, false);
});

test('输入变化立即作废旧游标,防抖等待期间不能发送新查询加旧游标', async (t) => {
  const h = harness(t);
  const initial = h.run();
  h.requests[0].resolve(page(['old'], 'old-cursor'));
  await initial;
  h.query.query = 'new';
  assert.equal(h.nextCursor.value, '');
  await h.run({ append: true });
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.results.value.map((item) => item.name), ['old']);
});

test('旧查询翻页不能拼进新查询结果', async (t) => {
  const h = harness(t);
  const initial = h.run();
  h.requests[0].resolve(page(['old'], 'old-cursor'));
  await initial;
  const more = h.run({ append: true });
  assert.equal(h.requests[1].params.cursor, 'old-cursor');
  h.query.latest_only = false;
  const latest = h.run();
  h.requests[2].resolve(page(['new'], 'new-cursor'));
  await latest;
  h.requests[1].resolve(page(['old-page-2'], 'old-cursor-2'));
  await more;
  assert.deepEqual(h.results.value.map((item) => item.name), ['new']);
  assert.equal(h.nextCursor.value, 'new-cursor');
});

test('同查询翻页去重并保留安装优先排序,重复点击不并发翻页', async (t) => {
  const h = harness(t);
  const initial = h.run();
  h.requests[0].resolve(page(['z'], 'page-2'));
  await initial;
  const more = h.run({ append: true });
  await h.run({ append: true });
  assert.equal(h.requests.length, 2);
  assert.equal(h.loadingMore.value, true);
  h.requests[1].resolve({ data: { items: [{ name: 'z', version: '1' }, { name: 'a', version: '1', installable: true }], next_cursor: '' } });
  await more;
  assert.deepEqual(h.results.value.map((item) => item.name), ['a', 'z']);
  assert.equal(h.loadingMore.value, false);
});

test('当前请求失败保留已有结果并支持用同一游标重试', async (t) => {
  const h = harness(t);
  const initial = h.run();
  h.requests[0].resolve(page(['old'], 'page-2'));
  await initial;
  const more = h.run({ append: true });
  h.requests[1].reject(new Error('offline'));
  await more;
  assert.equal(h.error.value, 'offline');
  assert.deepEqual(h.errors, ['offline']);
  assert.equal(h.nextCursor.value, 'page-2');
  const retry = h.run({ append: true });
  h.requests[2].resolve(page(['more']));
  await retry;
  assert.equal(h.error.value, '');
  assert.equal(h.results.value.length, 2);
});

test('离开页面后在途请求不修改状态或弹出错误', async (t) => {
  const h = harness(t);
  const pending = h.run();
  h.dispose();
  h.requests[0].reject(new Error('late failure'));
  await pending;
  assert.equal(h.loading.value, false);
  assert.deepEqual(h.errors, []);
});

function autoHarness(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const query = reactive({ query: '', latest_only: true });
  const dialog = reactive({ open: true, mode: 'registry' });
  const searches = [];
  const state = useMcpRegistryAutoSearch({ query, active: () => dialog.open && dialog.mode === 'registry', onSearch: () => searches.push(query.query) });
  t.after(state.dispose);
  return { query, dialog, searches, ...state };
}

test('连续输入只触发最后一次自动搜索', (t) => {
  const h = autoHarness(t);
  h.query.query = 'a';
  t.mock.timers.tick(200);
  h.query.query = 'ab';
  t.mock.timers.tick(399);
  assert.deepEqual(h.searches, []);
  t.mock.timers.tick(1);
  assert.deepEqual(h.searches, ['ab']);
});

test('手动搜索取消防抖中的重复请求', (t) => {
  const h = autoHarness(t);
  h.query.query = 'manual';
  h.searchNow();
  t.mock.timers.tick(400);
  assert.deepEqual(h.searches, ['manual']);
});

test('关闭弹窗、切换为手动模式及销毁均取消自动搜索', (t) => {
  const h = autoHarness(t);
  h.query.query = 'close';
  h.dialog.open = false;
  t.mock.timers.tick(400);
  h.dialog.open = true;
  h.query.query = 'switch';
  h.dialog.mode = 'manual';
  t.mock.timers.tick(400);
  h.dialog.mode = 'registry';
  h.query.query = 'dispose';
  h.dispose();
  t.mock.timers.tick(400);
  assert.deepEqual(h.searches, []);
});

test('仅最新版本变更会搜索,关闭期间变更及重新打开不自动搜索', (t) => {
  const h = autoHarness(t);
  h.query.latest_only = false;
  t.mock.timers.tick(400);
  assert.equal(h.searches.length, 1);
  h.dialog.open = false;
  h.query.query = 'hidden';
  h.searchNow();
  h.dialog.open = true;
  t.mock.timers.tick(400);
  assert.equal(h.searches.length, 1);
});
