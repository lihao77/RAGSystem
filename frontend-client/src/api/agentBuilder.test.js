import assert from 'node:assert/strict';
import test from 'node:test';

import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia } from 'pinia';

import {
  createAgentDraft,
  listAgentDrafts,
  listAgentReleases,
  publishAgentDraft,
  validateAgentDraft,
} from './agentBuilder.js';
import { httpClient } from './http.js';

function withMock(setup, run) {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  setup(mock);
  return Promise.resolve().then(run).finally(() => mock.restore());
}

test('Agent Builder API unwraps draft and release responses', async () => {
  await withMock((mock) => {
    mock.onGet('/api/agent-builder/drafts').reply(200, { success: true, data: [{ id: 'draft_1' }] });
    mock.onPost('/api/agent-builder/drafts').reply((config) => {
      assert.deepEqual(JSON.parse(config.data), { blueprint: { schema_version: 1 } });
      return [200, { success: true, data: { id: 'draft_2' } }];
    });
    mock.onGet('/api/agent-builder/releases?package_name=support-team').reply(200, {
      success: true,
      data: [{ id: 'release_1' }],
    });
  }, async () => {
    assert.deepEqual(await listAgentDrafts(), [{ id: 'draft_1' }]);
    assert.deepEqual(await createAgentDraft({ schema_version: 1 }), { id: 'draft_2' });
    assert.deepEqual(await listAgentReleases('support-team'), [{ id: 'release_1' }]);
  });
});

test('Agent Builder validation and publish use explicit draft revision', async () => {
  await withMock((mock) => {
    mock.onPost('/api/agent-builder/drafts/draft_1/validate').reply(200, {
      success: true,
      data: { id: 'draft_1', status: 'ready' },
    });
    mock.onPost('/api/agent-builder/drafts/draft_1/publish').reply((config) => {
      assert.deepEqual(JSON.parse(config.data), { expected_revision: 3 });
      return [200, { success: true, data: { id: 'release_1', version: 1 } }];
    });
  }, async () => {
    assert.equal((await validateAgentDraft('draft_1')).status, 'ready');
    assert.equal((await publishAgentDraft('draft_1', 3)).version, 1);
  });
});
