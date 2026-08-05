import assert from 'node:assert/strict';
import test from 'node:test';

import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia } from 'pinia';

import {
  createAgentDraft,
  deleteAgentDraft,
  listAgentDrafts,
  publishAgentDraft,
} from './agentBuilder.js';
import { httpClient } from './http.js';

function withMock(setup, run) {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  setup(mock);
  return Promise.resolve().then(run).finally(() => mock.restore());
}

test('Agent Builder API unwraps draft responses', async () => {
  await withMock((mock) => {
    mock.onGet('/api/agent-builder/drafts').reply(200, { success: true, data: [{ id: 'draft_1' }] });
    mock.onPost('/api/agent-builder/drafts').reply((config) => {
      assert.deepEqual(JSON.parse(config.data), { blueprint: { schema_version: 1 } });
      return [200, { success: true, data: { id: 'draft_2' } }];
    });
  }, async () => {
    assert.deepEqual(await listAgentDrafts(), [{ id: 'draft_1' }]);
    assert.deepEqual(await createAgentDraft({ schema_version: 1 }), { id: 'draft_2' });
  });
});

test('Agent Builder publish uses the explicit draft revision and delete has no body', async () => {
  await withMock((mock) => {
    mock.onPost('/api/agent-builder/drafts/draft_1/publish').reply((config) => {
      assert.deepEqual(JSON.parse(config.data), { expected_revision: 3 });
      return [200, { success: true, data: { id: 'draft_1', status: 'published' } }];
    });
    mock.onDelete('/api/agent-builder/drafts/draft_1').reply((config) => {
      assert.equal(config.data, undefined);
      return [200, { success: true, data: { id: 'draft_1' } }];
    });
  }, async () => {
    assert.equal((await publishAgentDraft('draft_1', 3)).status, 'published');
    assert.equal((await deleteAgentDraft('draft_1')).id, 'draft_1');
  });
});
