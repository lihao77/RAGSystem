import assert from 'node:assert/strict';
import test from 'node:test';

import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia } from 'pinia';

import {
  createSkillDraft,
  deleteSkillDraft,
  getSkillDraft,
  listSkillDrafts,
  publishSkillDraft,
  updateSkillDraft,
} from './skillLibrary.js';
import { httpClient } from './http.js';

function withMock(setup, run) {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  setup(mock);
  return Promise.resolve().then(run).finally(() => mock.restore());
}

test('Skill draft API unwraps list and item responses', async () => {
  await withMock((mock) => {
    mock.onGet('/api/skills/drafts').reply(200, { success: true, data: [{ id: 'draft_1' }] });
    mock.onGet('/api/skills/drafts/draft_1').reply(200, { success: true, data: { id: 'draft_1', revision: 2 } });
  }, async () => {
    assert.deepEqual(await listSkillDrafts(), [{ id: 'draft_1' }]);
    assert.deepEqual(await getSkillDraft('draft_1'), { id: 'draft_1', revision: 2 });
  });
});

test('Skill draft API sends explicit revisions for create, update, publish, and delete', async () => {
  await withMock((mock) => {
    mock.onPost('/api/skills/drafts').reply((config) => {
      assert.deepEqual(JSON.parse(config.data), {
        name: 'incident-response',
        description: 'Respond safely',
        content: '# Triage',
      });
      return [200, { success: true, data: { id: 'draft_1', revision: 1 } }];
    });
    mock.onPut('/api/skills/drafts/draft_1').reply((config) => {
      assert.deepEqual(JSON.parse(config.data), {
        expected_revision: 1,
        name: 'incident-response',
        description: 'Respond safely',
        content: '# Triage updated',
      });
      return [200, { success: true, data: { id: 'draft_1', revision: 2 } }];
    });
    mock.onPost('/api/skills/drafts/draft_1/publish').reply((config) => {
      assert.deepEqual(JSON.parse(config.data), { expected_revision: 2 });
      return [200, { success: true, data: { id: 'draft_1', status: 'published' } }];
    });
    mock.onDelete('/api/skills/drafts/draft_1').reply((config) => {
      assert.deepEqual(JSON.parse(config.data), { expected_revision: 2 });
      return [200, { success: true, data: { id: 'draft_1' } }];
    });
  }, async () => {
    assert.equal((await createSkillDraft({
      name: 'incident-response',
      description: 'Respond safely',
      content: '# Triage',
    })).revision, 1);
    assert.equal((await updateSkillDraft('draft_1', 1, {
      name: 'incident-response',
      description: 'Respond safely',
      content: '# Triage updated',
    })).revision, 2);
    assert.equal((await publishSkillDraft('draft_1', 2)).status, 'published');
    assert.equal((await deleteSkillDraft('draft_1', 2)).id, 'draft_1');
  });
});
