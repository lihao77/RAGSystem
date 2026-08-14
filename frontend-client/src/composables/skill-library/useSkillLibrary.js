/**
 * Skill 库核心编排：列表加载、选中态、脏检查守卫、409 恢复、发布态回写。
 * 文件编辑/保存等 mutation 在 useSkillDraftFiles；Draft 级 mutation 在 useSkillDraftActions。
 */

import {
  getSkillDetail,
  getSkillDraft,
  getSkillDraftFile,
  listSkillDrafts,
  listSkills,
} from '../../api/skillLibrary.js';
import { decodeBase64Text } from '../../utils/base64.js';
import { isEditableTextFile } from '../../utils/skillFiles.js';
import { togglePathInSet } from '../../utils/fileTree.js';

export function useSkillLibrary(state, { toast, confirm }) {
  async function refreshAll({ selectDefault = false } = {}) {
    state.loadingAll.value = true;
    state.skillsLoading.value = true;
    state.draftsLoading.value = true;
    state.skillsError.value = '';
    state.draftsError.value = '';
    const [draftResult, skillResult] = await Promise.allSettled([listSkillDrafts(), listSkills()]);
    if (draftResult.status === 'fulfilled') state.skillDrafts.value = draftResult.value;
    else state.draftsError.value = draftResult.reason?.message || '加载 Skill Draft 失败';
    if (skillResult.status === 'fulfilled') state.skills.value = skillResult.value.data || [];
    else state.skillsError.value = skillResult.reason?.message || '加载 Skill 库失败';
    state.draftsLoading.value = false;
    state.skillsLoading.value = false;
    state.loadingAll.value = false;

    if (selectDefault && !state.activeKey.value) {
      if (state.skillDrafts.value.length) await selectDraft(state.skillDrafts.value[0], { skipGuard: true });
      else if (state.skills.value.length) {
        state.navigatorTab.value = 'library';
        await selectSkill(state.skills.value[0], { skipGuard: true });
      }
      return;
    }
    if (state.activeKind.value === 'draft') {
      const latest = state.skillDrafts.value.find((draft) => draft.id === state.activeKey.value);
      if (latest) await selectDraft(latest, { skipGuard: true });
    } else if (state.activeKind.value === 'skill') {
      const latest = state.skills.value.find((skill) => skill.name === state.activeKey.value);
      if (latest) await selectSkill(latest, { skipGuard: true });
    }
  }

  async function handleRefresh() {
    if (!await allowDiscardChanges()) return;
    await refreshAll();
  }

  async function changeNavigatorTab(value) {
    if (!value || value === state.navigatorTab.value) return;
    if (!await allowDiscardChanges()) return;
    state.navigatorTab.value = value;
    state.searchQuery.value = '';
    if (value === 'drafts' && state.skillDrafts.value.length) await selectDraft(state.skillDrafts.value[0], { skipGuard: true });
    if (value === 'library' && state.skills.value.length) await selectSkill(state.skills.value[0], { skipGuard: true });
  }

  async function selectDraft(draft, { skipGuard = false } = {}) {
    if (!skipGuard && state.activeKind.value === 'draft' && state.activeKey.value === draft.id) return;
    if (!skipGuard && !await allowDiscardChanges()) return;
    state.navigatorTab.value = 'drafts';
    state.activeKind.value = 'draft';
    state.activeKey.value = draft.id;
    state.selectedSkill.value = null;
    state.overviewMode.value = 'edit';
    state.workspaceLoading.value = true;
    state.workspaceError.value = '';
    resetFileEditor();
    try {
      const loaded = await getSkillDraft(draft.id);
      applyDraft(loaded);
      if (state.workspaceTab.value === 'files') await selectDraftFile('SKILL.md', { skipGuard: true });
    } catch (error) {
      state.activeDraft.value = null;
      state.workspaceError.value = error?.message || '加载 Skill Draft 失败';
    } finally {
      state.workspaceLoading.value = false;
    }
  }

  async function selectSkill(skill, { skipGuard = false } = {}) {
    if (!skipGuard && state.activeKind.value === 'skill' && state.activeKey.value === skill.name) return;
    if (!skipGuard && !await allowDiscardChanges()) return;
    state.navigatorTab.value = 'library';
    state.activeKind.value = 'skill';
    state.activeKey.value = skill.name;
    state.activeDraft.value = null;
    state.publishedTab.value = 'overview';
    state.publishedCollapsedDirectories.value = new Set();
    state.workspaceLoading.value = true;
    state.workspaceError.value = '';
    resetFileEditor();
    try {
      const response = await getSkillDetail(skill.name);
      state.selectedSkill.value = response.data;
    } catch (error) {
      state.selectedSkill.value = null;
      state.workspaceError.value = error?.message || '加载 Skill 详情失败';
    } finally {
      state.workspaceLoading.value = false;
    }
  }

  function applyDraft(draft) {
    state.activeDraft.value = draft;
    state.activeKind.value = 'draft';
    state.activeKey.value = draft.id;
    state.draftForm.value = { name: draft.name, description: draft.description, content: draft.content };
    const index = state.skillDrafts.value.findIndex((item) => item.id === draft.id);
    if (index >= 0) state.skillDrafts.value.splice(index, 1, draft);
    else state.skillDrafts.value.unshift(draft);
  }

  async function changeWorkspaceTab(value) {
    if (!value || value === state.workspaceTab.value) return;
    if (!await allowDiscardChanges()) return;
    state.workspaceTab.value = value;
    state.workspaceError.value = '';
    if (value === 'files' && state.activeDraft.value) await selectDraftFile('SKILL.md', { skipGuard: true });
  }

  // 胶囊分段控件取消选中时会 emit 空值，这里统一挡掉
  function changeOverviewMode(value) {
    if (value) state.overviewMode.value = value;
  }

  function changePublishedTab(value) {
    if (value) state.publishedTab.value = value;
  }

  async function allowDiscardChanges() {
    if (!state.hasUnsavedChanges.value) return true;
    return confirm({
      title: '放弃未保存更改',
      message: '当前编辑内容尚未保存，继续操作会丢失这些更改。',
      confirmText: '放弃更改',
      danger: true,
    });
  }

  async function recoverDraft(id) {
    try {
      applyDraft(await getSkillDraft(id));
      resetFileEditor();
    } catch {
      // Preserve the original mutation error when recovery is unavailable.
    }
  }

  async function syncPublishedState(draft) {
    if (draft.status !== 'published') return;
    try {
      const response = await listSkills();
      state.skills.value = response.data || [];
    } catch (error) {
      state.skillsError.value = error?.message || 'Skill 已更新，但刷新 Skill 库失败';
      toast.warning(state.skillsError.value);
    }
  }

  function resetFileEditor() {
    state.selectedFilePath.value = '';
    state.selectedFile.value = null;
    state.fileText.value = '';
    state.originalFileText.value = '';
  }

  async function selectDraftFile(relativePath, { skipGuard = false } = {}) {
    if (!state.activeDraft.value) return;
    if (!skipGuard && state.selectedFilePath.value === relativePath) return;
    if (!skipGuard && state.fileDirty.value && !await allowDiscardChanges()) return;
    state.selectedFilePath.value = relativePath;
    state.selectedFile.value = null;
    state.fileLoading.value = true;
    state.workspaceError.value = '';
    try {
      const file = await getSkillDraftFile(state.activeDraft.value.id, relativePath);
      state.selectedFile.value = file;
      if (isEditableTextFile(file)) {
        state.fileText.value = decodeBase64Text(file.body_base64);
        state.originalFileText.value = state.fileText.value;
      } else {
        state.fileText.value = '';
        state.originalFileText.value = '';
      }
    } catch (error) {
      state.selectedFilePath.value = '';
      state.workspaceError.value = error?.message || '读取 Draft 文件失败';
    } finally {
      state.fileLoading.value = false;
    }
  }

  function toggleDirectory(path) {
    state.collapsedDirectories.value = togglePathInSet(state.collapsedDirectories.value, path);
  }

  function setSearchQuery(value) {
    state.searchQuery.value = value;
  }

  function togglePublishedDirectory(path) {
    state.publishedCollapsedDirectories.value = togglePathInSet(state.publishedCollapsedDirectories.value, path);
  }

  return {
    refreshAll,
    handleRefresh,
    changeNavigatorTab,
    selectDraft,
    selectSkill,
    applyDraft,
    changeWorkspaceTab,
    changeOverviewMode,
    changePublishedTab,
    allowDiscardChanges,
    recoverDraft,
    syncPublishedState,
    resetFileEditor,
    selectDraftFile,
    toggleDirectory,
    togglePublishedDirectory,
    setSearchQuery,
  };
}
