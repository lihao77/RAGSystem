import test from 'node:test';
import assert from 'node:assert/strict';
import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia } from 'pinia';

import { httpClient } from '../api/http.js';
import { useDictionariesStore } from './dictionaries.js';

test('强制刷新 Provider 后更新共享缓存，后续读取复用最新值', async (t) => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  t.after(() => mock.restore());

  const responses = [
    [{ key: 'openai', name: 'OpenAI' }],
    [
      { key: 'openai', name: 'OpenAI' },
      { key: 'anthropic', name: 'Anthropic' },
    ],
  ];
  let requests = 0;
  mock.onGet('/api/model-adapter/providers').reply(() => {
    const providers = responses[requests] || [];
    requests += 1;
    return [200, { providers }];
  });

  const store = useDictionariesStore();
  assert.deepEqual(await store.ensureProviders(), responses[0]);
  assert.deepEqual(await store.ensureProviders(true), responses[1]);
  assert.deepEqual(store.providers, responses[1]);
  assert.deepEqual(await store.ensureProviders(), responses[1]);
  assert.equal(requests, 2);
});
