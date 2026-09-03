import test from 'node:test';
import assert from 'node:assert/strict';

import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia } from 'pinia';

import { blobToText, clearWorkspaceFileAssetCache, fetchWorkspaceFileAsset } from './useWorkspaceFileAsset.js';
import { httpClient } from '../../api/http.js';

const CONTENT_URL = '/api/agent/sessions/ses_1/workspace-files/content?path=report.md';

/**
 * mock 固定 CONTENT_URL，把每次请求的 If-None-Match 头记录进 requests，
 * 响应由 replyFor(inm) 按当前状态决定。
 */
function withMock(replyFor, run) {
  setActivePinia(createPinia());
  clearWorkspaceFileAssetCache();
  const mock = new MockAdapter(httpClient);
  const requests = [];
  mock.onGet(CONTENT_URL).reply((config) => {
    const ifNoneMatch = config.headers?.get?.('If-None-Match') ?? config.headers?.['If-None-Match'];
    requests.push(ifNoneMatch ?? undefined);
    return replyFor(ifNoneMatch);
  });
  return Promise.resolve()
    .then(() => run(requests))
    .finally(() => mock.restore());
}

function reply(body, headers) {
  return [200, body, { 'content-type': 'text/plain', ...headers }];
}

test('cached asset revalidates with If-None-Match and reuses the same entry on 304', async () => {
  await withMock(
    (inm) => (inm === '"v1"' ? [304, undefined, { etag: '"v1"' }] : reply('body-v1', { etag: '"v1"' })),
    async (requests) => {
      const first = await fetchWorkspaceFileAsset('ses_1', 'report.md');
      assert.equal(await first.blob.text(), 'body-v1');
      assert.equal(first.etag, '"v1"');

      const second = await fetchWorkspaceFileAsset('ses_1', 'report.md');
      // 304 时原对象复用：组件侧 asset 身份不变，不重建 objectURL/不重解码
      assert.equal(second, first);
      assert.deepEqual(requests, [undefined, '"v1"']);
    },
  );
});

test('changed file swaps in a fresh entry with the new etag', async () => {
  let version = 1;
  await withMock(
    (inm) => (inm === `"v${version}"` ? [304, undefined, { etag: `"v${version}"` }] : reply(`body-v${version}`, { etag: `"v${version}"` })),
    async () => {
      const stale = await fetchWorkspaceFileAsset('ses_1', 'report.md');
      version = 2;
      const fresh = await fetchWorkspaceFileAsset('ses_1', 'report.md');
      assert.notEqual(fresh, stale);
      assert.equal(await fresh.blob.text(), 'body-v2');
      assert.equal(fresh.etag, '"v2"');
      // 再取一次走 304 复用新条目
      assert.equal(await fetchWorkspaceFileAsset('ses_1', 'report.md'), fresh);
    },
  );
});

test('missing file evicts the cache, surfaces 404, and the next fetch starts clean', async () => {
  await withMock(
    (inm) => (inm === '"v1"' ? [404, { success: false, detail: '工作空间文件不存在' }] : reply('body-v1', { etag: '"v1"' })),
    async (requests) => {
      await fetchWorkspaceFileAsset('ses_1', 'report.md');
      await assert.rejects(
        () => fetchWorkspaceFileAsset('ses_1', 'report.md'),
        (error) => error.status === 404,
      );
      const again = await fetchWorkspaceFileAsset('ses_1', 'report.md');
      assert.equal(await again.blob.text(), 'body-v1');
      assert.deepEqual(requests, [undefined, '"v1"', undefined]);
    },
  );
});

test('transient revalidation failure falls back to the cached entry', async () => {
  await withMock(
    (inm) => (inm === '"v1"' ? [503, {}] : reply('body-v1', { etag: '"v1"' })),
    async (requests) => {
      const cached = await fetchWorkspaceFileAsset('ses_1', 'report.md');
      const served = await fetchWorkspaceFileAsset('ses_1', 'report.md');
      assert.equal(served, cached);
      assert.deepEqual(requests, [undefined, '"v1"']);
    },
  );
});

test('responses without etag skip caching and always refetch in full', async () => {
  let reads = 0;
  await withMock(
    () => {
      reads += 1;
      return reply(`body-${reads}`);
    },
    async (requests) => {
      assert.equal(await (await fetchWorkspaceFileAsset('ses_1', 'report.md')).blob.text(), 'body-1');
      assert.equal(await (await fetchWorkspaceFileAsset('ses_1', 'report.md')).blob.text(), 'body-2');
      assert.deepEqual(requests, [undefined, undefined]);
    },
  );
});

test('concurrent fetches share one request and one entry', async () => {
  await withMock(
    () => reply('body-v1', { etag: '"v1"' }),
    async (requests) => {
      const [a, b] = await Promise.all([
        fetchWorkspaceFileAsset('ses_1', 'report.md'),
        fetchWorkspaceFileAsset('ses_1', 'report.md'),
      ]);
      assert.equal(a, b);
      assert.equal(requests.length, 1);
    },
  );
});

test('concurrent revalidations after a cache hit also deduplicate into one request', async () => {
  await withMock(
    (inm) => (inm === '"v1"' ? [304, undefined, { etag: '"v1"' }] : reply('body-v1', { etag: '"v1"' })),
    async (requests) => {
      const cached = await fetchWorkspaceFileAsset('ses_1', 'report.md');
      const [a, b] = await Promise.all([
        fetchWorkspaceFileAsset('ses_1', 'report.md'),
        fetchWorkspaceFileAsset('ses_1', 'report.md'),
      ]);
      assert.equal(a, cached);
      assert.equal(b, cached);
      assert.deepEqual(requests, [undefined, '"v1"']);
    },
  );
});

test('an aborted revalidation rejects instead of falling back to the cached entry', async () => {
  await withMock(
    (inm) => (inm === '"v1"' ? [304, undefined, { etag: '"v1"' }] : reply('body-v1', { etag: '"v1"' })),
    async (requests) => {
      await fetchWorkspaceFileAsset('ses_1', 'report.md');
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () => fetchWorkspaceFileAsset('ses_1', 'report.md', { signal: controller.signal }),
        (error) => error instanceof Error,
      );
      // abort 的请求未发出，缓存不受影响：后续取用仍可复用条目
      const again = await fetchWorkspaceFileAsset('ses_1', 'report.md');
      assert.equal(await again.blob.text(), 'body-v1');
      assert.deepEqual(requests, [undefined, '"v1"']);
    },
  );
});

test('blobToText decodes up to the limit and reports truncation', async () => {
  const { text, truncated } = await blobToText(new Blob(['abcdef']), 4);
  assert.equal(text, 'abcd');
  assert.equal(truncated, true);

  const full = await blobToText(new Blob(['abc']), 4);
  assert.equal(full.text, 'abc');
  assert.equal(full.truncated, false);
});
