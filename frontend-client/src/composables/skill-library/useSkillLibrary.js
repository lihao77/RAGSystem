import { getSkillBundle, saveSkillBundle, listSkills, deleteSkill } from '../../api/skillLibrary.js';
import { encodeBase64Text, decodeBase64Bytes, readFileAsBase64 } from '../../utils/base64.js';
import { isValidSkillBundlePath, guessMediaType } from '../../utils/skillFiles.js';
import { readZipBundle, readFolderBundle, createSkillZip } from '../../utils/skillArchive.js';
import { togglePathInSet } from '../../utils/fileTree.js';
import { filesBaseline } from './state.js';

export function useSkillLibrary(state, { toast, confirm }) {
  let selection = 0;
  async function allowDiscardChanges() {
    if (state.busy.value || state.loading.value) return false;
    return !state.hasUnsavedChanges.value || await confirm({ title: '放弃未保存修改', message: '当前修改尚未保存，继续操作将丢失这些内容。', confirmText: '放弃修改', danger: true });
  }
  function applySkill(skill) {
    state.activeSkill.value = structuredClone(skill);
    state.originalFiles.value = filesBaseline(skill.files);
    if (!skill.files.some((file) => file.relative_path === state.selectedFilePath.value)) state.selectedFilePath.value = 'SKILL.md';
    state.error.value = '';
  }
  async function refreshList() {
    try { state.skills.value = (await listSkills()).data || []; state.listError.value = ''; }
    catch (error) { state.listError.value = error.message || '加载 Skill 列表失败'; }
  }
  async function refreshAll() {
    if (!await allowDiscardChanges()) return;
    state.loading.value = true;
    try {
      await refreshList();
      const name = state.activeSkill.value?.name;
      const next = state.skills.value.find((item) => item.name === name) || state.skills.value[0];
      if (next) await selectSkill(next, true);
      else state.activeSkill.value = null;
    } catch (error) { state.error.value = error.message; }
    finally { state.loading.value = false; }
  }
  async function selectSkill(skill, skipGuard = false) {
    if (!skipGuard) {
      if (state.busy.value || state.loading.value) return false;
      if (state.activeSkill.value?.name === skill.name) return true;
      if (!await allowDiscardChanges() || state.busy.value || state.loading.value) return false;
    }
    const request = ++selection;
    state.loading.value = true;
    try {
      const loaded = await getSkillBundle(skill.name);
      if (request !== selection) return false;
      applySkill(loaded);
      return true;
    }
    catch (error) { if (request === selection) state.error.value = error.message; }
    finally { if (request === selection) state.loading.value = false; }
    return false;
  }
  async function save() {
    if (!state.canEdit.value || state.busy.value || state.loading.value || !state.hasUnsavedChanges.value) return;
    state.busy.value = true;
    try {
      const current = state.activeSkill.value;
      const saved = await saveSkillBundle(current.name, current.revision, current.files);
      applySkill(saved);
      await refreshList();
      toast.success('Skill 已保存并生效');
    } catch (error) {
      // Keep the user's complete buffer and original revision on conflicts or failed validation.
      state.error.value = error.status === 409 ? 'Skill 已被其他操作修改。当前修改已保留，请先导出，再重新加载并合并内容。' : error.message;
    } finally { state.busy.value = false; }
  }
  async function remove() {
    if (!state.canEdit.value || state.busy.value || state.loading.value) return;
    const current = state.activeSkill.value;
    if (!await confirm({ title: '删除 Skill', message: `确认删除“${current.name}”？相关 Agent 的绑定也会移除。`, confirmText: '删除', danger: true })) return;
    state.busy.value = true;
    try {
      if (current.revision) await deleteSkill(current.name, current.revision);
      state.activeSkill.value = null;
      await refreshList();
      toast.success('Skill 已删除');
    } catch (error) { state.error.value = error.message; }
    finally { state.busy.value = false; }
  }
  async function openCreate() {
    if (!state.canManage.value || !await allowDiscardChanges()) return;
    state.createDialog.value = { open: true, name: '', description: '' };
  }
  function create() {
    if (!state.canManage.value || !state.canCreate.value || state.busy.value || state.loading.value) return;
    const { name, description } = state.createDialog.value;
    if (state.skills.value.some((skill) => skill.name === name)) { state.error.value = '同名 Skill 已存在，请打开后编辑。'; return; }
    applySkill({ name, description, revision: null, writable: true, files: [{ relative_path: 'SKILL.md', media_type: 'text/markdown', body_base64: encodeBase64Text(`---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`) }] });
    state.selectedFilePath.value = 'SKILL.md';
    state.editorMode.value = 'edit';
    state.createDialog.value.open = false;
  }
  function selectFile(path) { if (!state.busy.value && !state.loading.value) state.selectedFilePath.value = path; }
  function toggleDirectory(path) { state.collapsedDirectories.value = togglePathInSet(state.collapsedDirectories.value, path); }
  function openCreateFile() { if (state.canEdit.value && !state.busy.value && !state.loading.value) state.createFileDialog.value = { open: true, path: '', content: '', error: '' }; }
  function createFile() {
    if (!state.canEdit.value || state.busy.value || state.loading.value || !state.canCreateFile.value) return;
    const relative = state.createFileDialog.value.path.replaceAll('\\', '/');
    if (state.activeSkill.value.files.some((file) => file.relative_path.toLowerCase() === relative.toLowerCase())) { state.createFileDialog.value.error = '同名文件已存在'; return; }
    state.activeSkill.value.files.push({ relative_path: relative, media_type: guessMediaType(relative), body_base64: encodeBase64Text(state.createFileDialog.value.content) });
    state.selectedFilePath.value = relative;
    state.createFileDialog.value.open = false;
  }
  async function upload(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !state.canEdit.value || state.busy.value || state.loading.value) return;
    const relative = file.webkitRelativePath || file.name;
    if (!isValidSkillBundlePath(relative) || file.size > 50 * 1024 * 1024) { state.error.value = '文件路径无效或文件超过 50MB'; return; }
    const current = state.activeSkill.value;
    const index = current.files.findIndex((entry) => entry.relative_path.toLowerCase() === relative.toLowerCase());
    if (index >= 0 && !await confirm({ title: '替换文件', message: `替换“${relative}”？保存 Skill 后生效。`, confirmText: '替换' })) return;
    state.busy.value = true;
    try {
      const item = { relative_path: relative, media_type: file.type || guessMediaType(relative), body_base64: await readFileAsBase64(file) };
      if (index >= 0) current.files.splice(index, 1, item); else current.files.push(item);
      state.selectedFilePath.value = relative;
    } catch (error) { state.error.value = error.message; }
    finally { state.busy.value = false; }
  }
  async function removeFile() {
    const file = state.selectedFile.value;
    if (!file || !state.canEdit.value || state.busy.value || state.loading.value || file.relative_path === 'SKILL.md') return;
    if (!await confirm({ title: '删除文件', message: `删除“${file.relative_path}”？保存 Skill 后生效。`, confirmText: '删除', danger: true })) return;
    state.activeSkill.value.files = state.activeSkill.value.files.filter((item) => item !== file);
    state.selectedFilePath.value = 'SKILL.md';
  }
  function downloadFile() {
    const file = state.selectedFile.value;
    if (file) download(new Blob([decodeBase64Bytes(file.body_base64)], { type: file.media_type }), file.relative_path.split('/').pop());
  }
  function exportSkill() {
    if (state.activeSkill.value) download(new Blob([JSON.stringify(state.activeSkill.value, null, 2)], { type: 'application/json' }), `${state.activeSkill.value.name}.json`);
  }
  async function exportSkillZip() {
    const current = state.activeSkill.value;
    if (!current || state.busy.value || state.loading.value) return;
    state.busy.value = true;
    try { download(await createSkillZip(current.files), `${current.name}.zip`); }
    catch (error) { state.error.value = error.message || '导出失败'; }
    finally { state.busy.value = false; }
  }
  async function importSkill(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !state.canManage.value || !await allowDiscardChanges()) return;
    state.busy.value = true;
    try {
      if (file.size > 70 * 1024 * 1024) throw new Error('导入文件超过 70MB');
      const input = JSON.parse(await file.text());
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.name)) throw new Error('Skill 名称无效');
      const files = input.files;
      if (!Array.isArray(files) || !files.length || files.length > 256) throw new Error('导入内容中没有有效的 Skill 文件');
      const cleanFiles = files.map(({ relative_path, media_type, body_base64 }) => {
        if (!isValidSkillBundlePath(relative_path) || typeof body_base64 !== 'string') throw new Error('导入内容中含有无效文件');
        decodeBase64Bytes(body_base64);
        return { relative_path, media_type: media_type || guessMediaType(relative_path), body_base64 };
      });
      if (!cleanFiles.some((entry) => entry.relative_path === 'SKILL.md')) throw new Error('导入内容缺少 SKILL.md');
      await loadImportedBundle(input.name, input.description || '', cleanFiles);
    } catch (error) { state.error.value = error.message || '导入失败'; }
    finally { state.busy.value = false; }
  }
  async function importZipSkill(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !state.canManage.value || !await allowDiscardChanges()) return;
    state.busy.value = true;
    try {
      if (file.size > 70 * 1024 * 1024) throw new Error('导入文件超过 70MB');
      const bundle = await readZipBundle(await file.arrayBuffer());
      await loadImportedBundle(bundle.name, bundle.description, bundle.files);
    } catch (error) { state.error.value = error.message || '导入失败'; }
    finally { state.busy.value = false; }
  }
  async function importFolderSkill(event) {
    const files = event.target.files;
    event.target.value = '';
    if (!files?.length || !state.canManage.value || !await allowDiscardChanges()) return;
    state.busy.value = true;
    try {
      const bundle = await readFolderBundle(files);
      await loadImportedBundle(bundle.name, bundle.description, bundle.files);
    } catch (error) { state.error.value = error.message || '导入失败'; }
    finally { state.busy.value = false; }
  }
  async function loadImportedBundle(name, description, files) {
    let current = null;
    try { current = await getSkillBundle(name); } catch (error) { if (error.status !== 404) throw error; }
    if (current && !current.writable) throw new Error('内置和工作区 Skill 只读');
    applySkill({ name, description, revision: current?.revision ?? null, writable: true, files });
    state.originalFiles.value = filesBaseline(current?.files ?? []);
    state.selectedFilePath.value = 'SKILL.md';
    toast.success('内容已载入编辑器，检查后保存生效');
  }
  return { refreshAll, selectSkill, save, remove, openCreate, create, allowDiscardChanges, applySkill,
    selectFile, toggleDirectory, openCreateFile, createFile, upload, removeFile, downloadFile, exportSkill, exportSkillZip, importSkill, importZipSkill, importFolderSkill };
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  URL.revokeObjectURL(url);
}
