import assert from 'node:assert/strict';
import test from 'node:test';
import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia } from 'pinia';
import { httpClient } from './http.js';
import { getSkillBundle, saveSkillBundle, deleteSkill } from './skillLibrary.js';

test('bundle API saves a complete revision and never sends UI-only fields', async () => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  try {
    mock.onGet('/api/skills/demo/bundle').reply(200, { data: { name: 'demo', revision: 'abc', files: [] } });
    mock.onPut('/api/skills/demo/bundle').reply((request) => {
      assert.deepEqual(JSON.parse(request.data), { expected_revision: 'abc', files: [{ relative_path: 'SKILL.md', body_base64: 'eA==' }] });
      return [200, { data: { revision: 'def' } }];
    });
    mock.onDelete('/api/skills/demo').reply((request) => { assert.equal(request.params.expected_revision, 'def'); return [200, {}]; });
    assert.equal((await getSkillBundle('demo')).revision, 'abc');
    assert.equal((await saveSkillBundle('demo', 'abc', [{ relative_path: 'SKILL.md', body_base64: 'eA==', size: 1, selected: true }])).revision, 'def');
    await deleteSkill('demo', 'def');
  } finally { mock.restore(); }
});
