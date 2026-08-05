import assert from 'node:assert/strict';
import test from 'node:test';

import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia } from 'pinia';

import {
  createSkillDraft,
  deleteSkillDraft,
  ensureSkillDraft,
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
    mock.onPost('/api/skills/drafts').reply((config) => {
      assert.deepEqual(JSON.parse(config.data), { name: 'new-skill', description: 'New Skill' });
      return [200, { success: true, data: { id: 'draft_new', name: 'new-skill' } }];
    });
    mock.onGet('/api/skills/drafts').reply(200, { success: true, data: [{ id: 'draft_1' }] });
    mock.onGet('/api/skills/drafts/draft_1').reply(200, { success: true, data: { id: 'draft_1', revision: 2 } });
  }, async () => {
    assert.equal((await createSkillDraft('new-skill', 'New Skill')).id, 'draft_new');
    assert.deepEqual(await listSkillDrafts(), [{ id: 'draft_1' }]);
    assert.deepEqual(await getSkillDraft('draft_1'), { id: 'draft_1', revision: 2 });
  });
});

test('Skill draft API updates content, publishes by revision, and deletes directly', async () => {
  await withMock((mock) => {
    mock.onPost('/api/skills/review-code/draft').reply((config) => {
      assert.deepEqual(JSON.parse(config.data), {});
      return [200, { success: true, data: { id: 'draft_restored', status: 'published' } }];
    });
    mock.onPut('/api/skills/drafts/draft_1').reply((config) => {
      assert.deepEqual(JSON.parse(config.data), {
        expected_revision: 1,
        name: 'review-code',
        description: 'Review code',
        content: 'Updated instructions',
      });
      return [200, { success: true, data: { id: 'draft_1', revision: 2, status: 'draft' } }];
    });
    mock.onPost('/api/skills/drafts/draft_1/publish').reply((config) => {
      assert.deepEqual(JSON.parse(config.data), { expected_revision: 1 });
      return [200, { success: true, data: { id: 'draft_1', status: 'published' } }];
    });
    mock.onDelete('/api/skills/drafts/draft_1').reply((config) => {
      assert.equal(config.data, undefined);
      return [200, { success: true, data: { id: 'draft_1' } }];
    });
  }, async () => {
    assert.equal((await ensureSkillDraft('review-code')).id, 'draft_restored');
    assert.equal((await updateSkillDraft('draft_1', 1, {
      name: 'review-code',
      description: 'Review code',
      content: 'Updated instructions',
    })).revision, 2);
    assert.equal((await publishSkillDraft('draft_1', 1)).status, 'published');
    assert.equal((await deleteSkillDraft('draft_1')).id, 'draft_1');
  });
});
