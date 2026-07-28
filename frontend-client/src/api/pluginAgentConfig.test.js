import test from 'node:test';
import assert from 'node:assert/strict';
import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia } from 'pinia';

import { httpClient } from './http.js';
import {
  getKnowledgeAgentConfig,
  resetKnowledgeAgentConfig,
  updateKnowledgeAgentConfig,
} from './knowledgeBase.js';
import {
  getMemoryAgentConfig,
  resetMemoryAgentConfig,
  updateMemoryAgentConfig,
} from './memory.js';

function withMock(setup, run) {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  setup(mock);
  return Promise.resolve().then(run).finally(() => mock.restore());
}

test('knowledge Agent config uses the plugin-owned route for read, update, and reset', async () => {
  const url = '/api/knowledge-bases/agents/writer%2Fagent/config?team=product%2Fteam';
  const config = {
    enabled: true,
    default_collection: 'product',
    default_search_mode: 'hybrid',
    default_top_k: 5,
    default_rerank: false,
    default_reranker_key: null,
  };
  await withMock((mock) => {
    mock.onGet(url).reply(200, { data: config });
    mock.onPut(url, config).reply(200, { data: config });
    mock.onDelete(url).reply(200, { data: { ...config, enabled: false } });
  }, async () => {
    assert.equal((await getKnowledgeAgentConfig('writer/agent', 'product/team')).enabled, true);
    assert.equal((await updateKnowledgeAgentConfig('writer/agent', config, 'product/team')).enabled, true);
    assert.equal((await resetKnowledgeAgentConfig('writer/agent', 'product/team')).enabled, false);
  });
});

test('memory Agent config uses the plugin-owned route for read, update, and reset', async () => {
  const url = '/api/memory/agents/writer%2Fagent/config?team=product%2Fteam';
  const config = {
    enabled: false,
    auto_inject: false,
    allowed_scopes: [],
    write_scopes: [],
    archive_scopes: [],
  };
  await withMock((mock) => {
    mock.onGet(url).reply(200, { data: config });
    mock.onPut(url, config).reply(200, { data: config });
    mock.onDelete(url).reply(200, { data: { ...config, enabled: true } });
  }, async () => {
    assert.equal((await getMemoryAgentConfig('writer/agent', 'product/team')).enabled, false);
    assert.equal((await updateMemoryAgentConfig('writer/agent', config, 'product/team')).enabled, false);
    assert.equal((await resetMemoryAgentConfig('writer/agent', 'product/team')).enabled, true);
  });
});
