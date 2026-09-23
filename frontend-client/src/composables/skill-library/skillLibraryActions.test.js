import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import MockAdapter from 'axios-mock-adapter';
import { createPinia, setActivePinia } from 'pinia';
import { httpClient } from '../../api/http.js';
import { useAuthStore } from '../../stores/auth.js';
import { useBootstrapStore } from '../../stores/bootstrap.js';
import { encodeBase64Text, decodeBase64Text } from '../../utils/base64.js';
import { createSkillLibraryState } from './state.js';
import { useSkillLibrary } from './useSkillLibrary.js';

function setup(t, role = 'admin') {
  setActivePinia(createPinia());
  useBootstrapStore().profile = { auth: 'password' };
  useAuthStore().role = role;
  const mock = new MockAdapter(httpClient); t.after(() => mock.restore());
  const state = createSkillLibraryState();
  const messages = [];
  const actions = useSkillLibrary(state, { toast: { success: (message) => messages.push(message) }, confirm: async () => true });
  const skill = { name: 'demo', revision: 'a'.repeat(64), writable: true, files: [{ relative_path: 'SKILL.md', media_type: 'text/markdown', body_base64: encodeBase64Text('original') }] };
  actions.applySkill(skill);
  return { mock, state, actions, messages, skill };
}

test('edits to multiple files stay local until one complete save', async (t) => {
  const { mock, state, actions, skill } = setup(t);
  state.fileText.value = 'new instructions';
  actions.openCreateFile();
  state.createFileDialog.value.path = 'scripts/check.py'; state.createFileDialog.value.content = 'print(1)'; actions.createFile();
  assert.equal(mock.history.put.length, 0);
  assert.equal(state.hasUnsavedChanges.value, true);
  assert.equal(state.fileChanges.value.get('SKILL.md'), 'modified');
  assert.equal(state.fileChanges.value.get('scripts/check.py'), 'added');
  mock.onPut('/api/skills/demo/bundle').reply((request) => {
    const body = JSON.parse(request.data);
    assert.equal(body.expected_revision, skill.revision);
    assert.equal(body.files.length, 2);
    assert.equal(decodeBase64Text(body.files[0].body_base64), 'new instructions');
    return [200, { data: { ...skill, revision: 'b'.repeat(64), files: body.files } }];
  });
  mock.onGet('/api/skills').reply(200, { data: [{ name: 'demo', source_type: 'user_global' }] });
  await actions.save();
  assert.equal(state.hasUnsavedChanges.value, false);
  assert.equal(state.fileChanges.value.size, 0);
  assert.equal(state.activeSkill.value.revision, 'b'.repeat(64));
});

test('409 keeps all local changes and the original revision for manual conflict resolution', async (t) => {
  const { mock, state, actions, skill } = setup(t);
  state.fileText.value = 'unsaved';
  mock.onPut('/api/skills/demo/bundle').reply(409, { message: 'conflict' });
  await actions.save();
  assert.equal(state.fileText.value, 'unsaved');
  assert.equal(state.activeSkill.value.revision, skill.revision);
  assert.equal(state.hasUnsavedChanges.value, true);
  assert.equal(state.fileChanges.value.get('SKILL.md'), 'modified');
  assert.match(state.error.value, /当前修改已保留/);
  assert.equal(mock.history.get.length, 0);
});

test('dirty state follows content, not edit history', async (t) => {
  const { state, actions } = setup(t);
  assert.equal(state.hasUnsavedChanges.value, false);
  state.fileText.value = 'changed';
  assert.equal(state.hasUnsavedChanges.value, true);
  state.fileText.value = 'original';
  assert.equal(state.hasUnsavedChanges.value, false);
  actions.openCreateFile();
  state.createFileDialog.value.path = 'notes.md'; state.createFileDialog.value.content = 'x'; actions.createFile();
  assert.equal(state.hasUnsavedChanges.value, true);
  state.selectedFilePath.value = 'notes.md';
  await actions.removeFile();
  assert.equal(state.hasUnsavedChanges.value, false);
});

test('creating a Skill does not write a placeholder to the server', async (t) => {
  const { mock, state, actions } = setup(t);
  await actions.openCreate();
  state.createDialog.value = { open: true, name: 'new-skill', description: '新的技能' };
  actions.create();
  assert.equal(state.activeSkill.value.revision, null);
  assert.equal(state.hasUnsavedChanges.value, true);
  assert.match(state.fileText.value, /name: new-skill/);
  assert.equal(state.fileChanges.value.get('SKILL.md'), 'added');
  assert.equal(mock.history.put.length, 0); assert.equal(mock.history.post.length, 0);
});

test('members and readonly sources cannot edit or submit', async (t) => {
  const { mock, state, actions } = setup(t, 'member');
  state.fileText.value = 'forbidden'; await actions.save();
  assert.equal(state.fileText.value, 'original');
  assert.equal(state.fileChanges.value.size, 0);
  assert.equal(mock.history.put.length, 0);
  useAuthStore().role = 'admin'; state.activeSkill.value.writable = false;
  state.fileText.value = 'still forbidden'; await actions.save();
  assert.equal(state.fileText.value, 'original');
  assert.equal(state.fileChanges.value.size, 0);
  assert.equal(mock.history.put.length, 0);
});

test('deletion removes the Skill without restoring a draft', async (t) => {
  const { mock, state, actions, skill } = setup(t);
  mock.onDelete('/api/skills/demo').reply((request) => { assert.equal(request.params.expected_revision, skill.revision); return [200, { data: { name: 'demo' } }]; });
  mock.onGet('/api/skills').reply(200, { data: [] });
  await actions.remove();
  assert.equal(state.activeSkill.value, null);
  assert.deepEqual(state.skills.value, []);
});

test('Skill bundle import is editable but not active until explicitly saved', async (t) => {
  const { mock, state, actions } = setup(t);
  mock.onGet('/api/skills/imported/bundle').reply(404, { message: 'missing' });
  await actions.importSkill({ target: { value: 'file', files: [{ size: 100, text: async () => JSON.stringify({ name: 'imported', files: [{ relative_path: 'SKILL.md', body_base64: encodeBase64Text('imported body'), media_type: 'text/markdown' }] }) }] } });
  assert.equal(state.activeSkill.value.name, 'imported');
  assert.equal(state.activeSkill.value.revision, null);
  assert.equal(state.fileText.value, 'imported body');
  assert.equal(state.fileChanges.value.get('SKILL.md'), 'added');
  assert.equal(mock.history.put.length, 0);
});

test('file markers track content and replacements by path, including collapsed folders', async (t) => {
  const { state, actions, skill } = setup(t);
  const files = [...skill.files,
    { relative_path: 'references/guide.md', media_type: 'text/markdown', body_base64: encodeBase64Text('guide') },
    { relative_path: 'assets/icon.png', media_type: 'image/png', body_base64: 'AP8N' },
  ];
  actions.applySkill({ ...skill, files });
  state.activeSkill.value.files.reverse();
  assert.equal(state.hasUnsavedChanges.value, false, 'reordering does not modify a file');
  actions.selectFile('references/guide.md');
  state.fileText.value = 'edited guide';
  actions.toggleDirectory('references');
  state.editorMode.value = 'preview';
  assert.equal(state.fileChanges.value.get('references/guide.md'), 'modified');
  assert.equal(state.fileTree.value.find(node => node.path === 'references').change, 'modified');
  assert.equal(state.fileTree.value.some(node => node.path === 'references/guide.md'), false);
  state.fileText.value = 'guide';
  assert.equal(state.fileChanges.value.size, 0);
  assert.equal(state.fileTree.value.find(node => node.path === 'references').change, undefined);
  const image = state.activeSkill.value.files.find(file => file.relative_path === 'assets/icon.png');
  image.body_base64 = 'AP8O';
  assert.equal(state.fileChanges.value.get('assets/icon.png'), 'modified', 'binary replacement is detected without decoding');
  image.body_base64 = 'AP8N'; image.media_type = 'image/webp';
  assert.equal(state.fileChanges.value.get('assets/icon.png'), 'modified', 'media type changes also need saving');
  image.media_type = 'image/png';
  actions.selectFile('references/guide.md');
  await actions.removeFile();
  assert.equal(state.fileChanges.value.get('references/guide.md'), 'deleted');
  assert.equal(state.hasUnsavedChanges.value, true);
  state.activeSkill.value.files.push(structuredClone(files[1]));
  assert.equal(state.fileChanges.value.size, 0);
  assert.equal(state.hasUnsavedChanges.value, false);
});

test('importing over a saved Skill marks changed and new files against the server baseline', async (t) => {
  const { mock, state, actions, skill } = setup(t);
  mock.onGet('/api/skills/demo/bundle').reply(200, { data: skill });
  const imported = { ...skill, files: [
    { ...skill.files[0], body_base64: encodeBase64Text('imported changes') },
    { relative_path: 'notes.txt', media_type: 'text/plain', body_base64: encodeBase64Text('new note') },
  ] };
  await actions.importSkill({ target: { value: 'file', files: [{ size: 200, text: async () => JSON.stringify(imported) }] } });
  assert.equal(state.fileChanges.value.get('SKILL.md'), 'modified');
  assert.equal(state.fileChanges.value.get('notes.txt'), 'added');
  actions.selectFile('SKILL.md'); state.fileText.value = 'original';
  assert.equal(state.fileChanges.value.has('SKILL.md'), false);
  assert.equal(state.fileChanges.value.get('notes.txt'), 'added');
});

test('zip import strips the wrapper folder and loads the editor without saving', async (t) => {
  const { mock, state, actions } = setup(t);
  mock.onGet('/api/skills/demo-skill/bundle').reply(404, { message: 'missing' });
  const zip = new JSZip();
  zip.file('demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: "来自压缩包"\n---\n\n说明');
  zip.file('demo-skill/scripts/run.py', 'print(1)');
  const buffer = await zip.generateAsync({ type: 'uint8array' });
  await actions.importZipSkill({ target: { value: 'file', files: [{ size: buffer.length, arrayBuffer: async () => buffer.buffer }] } });
  assert.equal(state.activeSkill.value.name, 'demo-skill');
  assert.equal(state.activeSkill.value.description, '来自压缩包');
  assert.deepEqual(state.activeSkill.value.files.map((file) => file.relative_path), ['SKILL.md', 'scripts/run.py']);
  assert.equal(state.fileChanges.value.get('scripts/run.py'), 'added');
  assert.equal(mock.history.put.length, 0);
});

test('folder import reads webkitRelativePath and drops build artifacts', async (t) => {
  const { state, actions } = setup(t);
  const encode = (text) => new TextEncoder().encode(text).buffer;
  await actions.importFolderSkill({ target: { value: 'file', files: [
    { name: 'SKILL.md', webkitRelativePath: 'my-skill/SKILL.md', size: 10, arrayBuffer: async () => encode('---\nname: my-skill\ndescription: 来自文件夹\n---\nx') },
    { name: 'run.py', webkitRelativePath: 'my-skill/scripts/run.py', size: 8, arrayBuffer: async () => encode('print(1)') },
    { name: 'index.js', webkitRelativePath: 'my-skill/node_modules/pkg/index.js', size: 4, arrayBuffer: async () => encode('junk') },
  ] } });
  assert.equal(state.activeSkill.value.name, 'my-skill');
  assert.deepEqual(state.activeSkill.value.files.map((file) => file.relative_path), ['SKILL.md', 'scripts/run.py']);
});

test('a broken zip keeps the current editor and surfaces the reason', async (t) => {
  const { mock, state, actions } = setup(t);
  await actions.importZipSkill({ target: { value: 'file', files: [{ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }] } });
  assert.match(state.error.value, /无法解析压缩包/);
  assert.equal(state.activeSkill.value.name, 'demo');
  assert.equal(mock.history.put.length, 0);
});

test('selecting the current Skill preserves the editing buffer without a request or confirmation', async (t) => {
  const { mock, state, skill } = setup(t);
  let confirmations = 0;
  const actions = useSkillLibrary(state, { toast: {}, confirm: async () => { confirmations++; return true; } });
  state.fileText.value = 'local edits';
  const active = state.activeSkill.value;
  assert.equal(await actions.selectSkill(skill), true);
  assert.equal(state.activeSkill.value, active);
  assert.equal(state.fileText.value, 'local edits');
  assert.equal(state.loading.value, false);
  assert.equal(mock.history.get.length, 0);
  assert.equal(confirmations, 0);
});

test('switching keeps current content until loaded and blocks edits while the request is pending', async (t) => {
  const { mock, state, actions, skill } = setup(t);
  let resolveResponse, started;
  const pending = new Promise(resolve => { resolveResponse = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  mock.onGet('/api/skills/next/bundle').reply(() => { started(); return pending; });
  const active = state.activeSkill.value;
  const switching = actions.selectSkill({ name: 'next' });
  await requested;
  assert.equal(state.loading.value, true);
  assert.equal(state.activeSkill.value, active);
  assert.equal(state.fileText.value, 'original');
  state.fileText.value = 'must not be overwritten by loading';
  actions.selectFile('other.txt');
  actions.openCreateFile();
  assert.equal(state.fileText.value, 'original');
  assert.equal(state.selectedFilePath.value, 'SKILL.md');
  assert.equal(state.createFileDialog.value.open, false);
  assert.equal(await actions.selectSkill({ name: 'next' }), false);
  assert.equal(mock.history.get.length, 1);
  resolveResponse([200, { data: { ...skill, name: 'next', files: [{ ...skill.files[0], body_base64: encodeBase64Text('next body') }] } }]);
  assert.equal(await switching, true);
  assert.equal(state.loading.value, false);
  assert.equal(state.activeSkill.value.name, 'next');
  assert.equal(state.fileText.value, 'next body');
});

test('a failed switch keeps edits and explicit refresh still reloads the selected Skill', async (t) => {
  const { mock, state, actions, skill } = setup(t);
  state.fileText.value = 'keep on error';
  mock.onGet('/api/skills/missing/bundle').reply(404, { message: 'missing' });
  assert.equal(await actions.selectSkill({ name: 'missing' }), false);
  assert.equal(state.fileText.value, 'keep on error');
  assert.equal(state.loading.value, false);
  mock.onGet('/api/skills').reply(200, { data: [{ name: 'demo' }] });
  mock.onGet('/api/skills/demo/bundle').reply(200, { data: skill });
  await actions.refreshAll();
  assert.equal(state.fileText.value, 'original');
  assert.equal(state.hasUnsavedChanges.value, false);
  assert.equal(mock.history.get.filter(request => request.url === '/api/skills/demo/bundle').length, 1);
});
