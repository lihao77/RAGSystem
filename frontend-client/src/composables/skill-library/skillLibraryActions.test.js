import assert from 'node:assert/strict';
import test from 'node:test';

import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia } from 'pinia';

import { httpClient } from '../../api/http.js';
import { createSkillLibraryState } from './state.js';
import { useSkillDraftActions } from './useSkillDraftActions.js';
import { useSkillLibrary } from './useSkillLibrary.js';

function setup() {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  const messages = [];
  const toast = {
    success: (m) => messages.push(['success', m]),
    warning: (m) => messages.push(['warning', m]),
    error: (m) => messages.push(['error', m]),
  };
  const confirm = async () => true;
  const state = createSkillLibraryState();
  const library = useSkillLibrary(state, { toast, confirm });
  const actions = useSkillDraftActions(state, library, { toast, confirm });
  const cleanup = () => mock.restore();
  return { mock, state, library, actions, messages, cleanup };
}

function seedDraft(state, overrides = {}) {
  const draft = {
    id: 'd1',
    name: 'demo',
    description: 'd',
    content: '# x',
    revision: 3,
    status: 'draft',
    published_at: null,
    bundle_assets: [{ relative_path: 'SKILL.md', size: 3 }],
    ...overrides,
  };
  state.activeDraft.value = draft;
  state.activeKind.value = 'draft';
  state.activeKey.value = draft.id;
  state.draftForm.value = { name: draft.name, description: draft.description, content: draft.content };
  return draft;
}

test('publish conflict (409) surfaces message and recovers the latest draft', async () => {
  const { mock, state, actions, messages, cleanup } = setup();
  seedDraft(state);
  mock.onPost('/api/skills/drafts/d1/publish').reply(409, { detail: '修订版本冲突' });
  mock.onGet('/api/skills/drafts/d1').reply(200, {
    data: { id: 'd1', name: 'demo', description: 'd', content: '# x2', revision: 4, status: 'draft', bundle_assets: [] },
  });

  await actions.publishDraft();

  assert.equal(state.workspaceError.value, '修订版本冲突');
  assert.equal(state.activeDraft.value.revision, 4, 'recoverDraft should apply the fresh draft');
  assert.equal(state.draftForm.value.content, '# x2');
  assert.equal(state.publishing.value, false);
  assert.ok(!messages.some(([level]) => level === 'success'));
  cleanup();
});

test('publish success applies draft and syncs the published library', async () => {
  const { mock, state, actions, messages, cleanup } = setup();
  seedDraft(state);
  mock.onPost('/api/skills/drafts/d1/publish').reply(200, {
    data: { id: 'd1', name: 'demo', description: 'd', content: '# x', revision: 4, status: 'published', published_at: '2026-08-14T00:00:00Z', bundle_assets: [] },
  });
  mock.onGet('/api/skills').reply(200, { data: [{ name: 'demo', source_type: 'user_global' }] });

  await actions.publishDraft();

  assert.equal(state.activeDraft.value.status, 'published');
  assert.equal(state.activeDraft.value.revision, 4);
  assert.equal(state.skills.value.length, 1, 'syncPublishedState should refresh the library list');
  assert.ok(messages.some(([level, text]) => level === 'success' && text === 'Skill 已发布'));
  cleanup();
});

test('delete draft resets selection and selects the next draft', async () => {
  const { mock, state, actions, library, cleanup } = setup();
  seedDraft(state);
  state.skillDrafts.value = [
    state.activeDraft.value,
    { id: 'd2', name: 'next', description: '', revision: 1, status: 'draft', bundle_assets: [] },
  ];
  mock.onDelete('/api/skills/drafts/d1').reply(200, {});
  mock.onGet('/api/skills/drafts/d2').reply(200, {
    data: { id: 'd2', name: 'next', description: '', content: '', revision: 1, status: 'draft', bundle_assets: [] },
  });

  await actions.deleteDraft();

  assert.equal(state.skillDrafts.value.length, 1);
  assert.equal(state.activeKey.value, 'd2', 'should auto-select the remaining draft');
  assert.equal(state.activeDraft.value.name, 'next');
  assert.ok(library);
  cleanup();
});

test('editPublishedSkill restores a draft via ensureSkillDraft', async () => {
  const { mock, state, actions, cleanup } = setup();
  state.selectedSkill.value = { name: 'published-skill', source_type: 'user_global', files: [] };
  mock.onPost('/api/skills/published-skill/draft').reply(200, {
    data: { id: 'd9', name: 'published-skill', description: '', content: '# s', revision: 1, status: 'draft', bundle_assets: [] },
  });

  await actions.editPublishedSkill();

  assert.equal(state.activeKind.value, 'draft');
  assert.equal(state.activeKey.value, 'd9');
  assert.equal(state.selectedSkill.value, null);
  assert.equal(state.navigatorTab.value, 'drafts');
  cleanup();
});
