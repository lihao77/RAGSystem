/**
 * Skill Draft 级动作：概览保存、发布、删除、创建，以及已发布 Skill 的编辑/删除。
 * 依赖 useSkillLibrary 提供的 applyDraft / recoverDraft / syncPublishedState 等编排能力。
 */

import {
  createSkillDraft,
  deleteSkill,
  deleteSkillDraft,
  ensureSkillDraft,
  publishSkillDraft,
  updateSkillDraft,
} from '../../api/skillLibrary.js';

export function useSkillDraftActions(state, library, { toast, confirm }) {
  async function saveOverview() {
    if (!state.activeDraft.value || !state.overviewDirty.value || !state.canEditSkillDraft.value) return;
    state.overviewSaving.value = true;
    state.workspaceError.value = '';
    const current = state.activeDraft.value;
    try {
      const updated = await updateSkillDraft(current.id, current.revision, state.draftForm.value);
      library.applyDraft(updated);
      await library.syncPublishedState(updated);
      toast.success(updated.status === 'published' ? 'Skill 已保存并自动发布' : 'Skill Draft 已保存');
    } catch (error) {
      state.workspaceError.value = error?.message || '保存 Skill Draft 失败';
      if (error?.status === 409) await library.recoverDraft(current.id);
    } finally {
      state.overviewSaving.value = false;
    }
  }

  async function publishDraft() {
    if (!state.activeDraft.value || state.hasUnsavedChanges.value || !state.canEditSkillDraft.value) return;
    const current = state.activeDraft.value;
    const accepted = await confirm({
      title: '发布 Skill Draft',
      message: `确认发布“${current.name}”？发布前会自动校验完整 bundle。`,
      confirmText: current.published_at ? '重新发布' : '发布',
      danger: false,
    });
    if (!accepted) return;
    state.publishing.value = true;
    state.workspaceError.value = '';
    try {
      const updated = await publishSkillDraft(current.id, current.revision);
      library.applyDraft(updated);
      await library.syncPublishedState(updated);
      toast.success('Skill 已发布');
    } catch (error) {
      state.workspaceError.value = error?.message || '发布 Skill 失败';
      if (error?.status === 409) await library.recoverDraft(current.id);
    } finally {
      state.publishing.value = false;
    }
  }

  async function deleteDraft() {
    if (!state.activeDraft.value || !state.canEditSkillDraft.value) return;
    const current = state.activeDraft.value;
    const accepted = await confirm({
      title: '删除 Skill Draft',
      message: current.status === 'published'
        ? `删除“${current.name}”的 Draft？已发布 Skill 不受影响，之后仍可从发布包恢复。`
        : `删除“${current.name}”的 Draft？此操作不可恢复。`,
      confirmText: '删除 Draft',
      danger: true,
    });
    if (!accepted) return;
    state.deletingDraft.value = true;
    state.workspaceError.value = '';
    try {
      await deleteSkillDraft(current.id);
      state.skillDrafts.value = state.skillDrafts.value.filter((draft) => draft.id !== current.id);
      state.activeDraft.value = null;
      state.activeKey.value = '';
      library.resetFileEditor();
      toast.success('Skill Draft 已删除');
      if (state.skillDrafts.value.length) await library.selectDraft(state.skillDrafts.value[0], { skipGuard: true });
      else if (state.skills.value.length) {
        state.navigatorTab.value = 'library';
        await library.selectSkill(state.skills.value[0], { skipGuard: true });
      }
    } catch (error) {
      state.workspaceError.value = error?.message || '删除 Skill Draft 失败';
    } finally {
      state.deletingDraft.value = false;
    }
  }

  async function editPublishedSkill() {
    if (!state.selectedSkill.value || !state.canEditSkillDraft.value) return;
    state.restoringDraft.value = true;
    state.workspaceError.value = '';
    try {
      const draft = await ensureSkillDraft(state.selectedSkill.value.name);
      library.applyDraft(draft);
      state.navigatorTab.value = 'drafts';
      state.workspaceTab.value = 'overview';
      state.selectedSkill.value = null;
      toast.success('已打开可编辑 Draft');
    } catch (error) {
      state.workspaceError.value = error?.message || '准备 Skill Draft 失败';
    } finally {
      state.restoringDraft.value = false;
    }
  }

  async function deletePublishedSkill() {
    if (!state.selectedSkill.value || !state.canEditSkillDraft.value) return;
    const current = state.selectedSkill.value;
    const accepted = await confirm({
      title: '删除已发布 Skill',
      message: `确认删除“${current.name}”？已有 Draft 会恢复为未发布状态。`,
      confirmText: '删除 Skill',
      danger: true,
    });
    if (!accepted) return;
    state.deletingSkill.value = true;
    state.workspaceError.value = '';
    try {
      await deleteSkill(current.name);
      state.selectedSkill.value = null;
      state.activeKey.value = '';
      await library.refreshAll();
      toast.success('已发布 Skill 已删除');
    } catch (error) {
      state.workspaceError.value = error?.message || '删除 Skill 失败';
    } finally {
      state.deletingSkill.value = false;
    }
  }

  function openCreateDraft() {
    state.createDraftDialog.value = { open: true, name: '', description: '', error: '' };
  }

  function updateDraftForm(field, value) {
    state.draftForm.value = { ...state.draftForm.value, [field]: value };
  }

  function closeCreateDraft() {
    if (state.creatingDraft.value) return;
    state.createDraftDialog.value.open = false;
    state.createDraftDialog.value.error = '';
  }

  async function createDraft() {
    if (!state.canCreateDraft.value) return;
    state.creatingDraft.value = true;
    state.createDraftDialog.value.error = '';
    try {
      const draft = await createSkillDraft(state.createDraftDialog.value.name, state.createDraftDialog.value.description);
      state.createDraftDialog.value.open = false;
      library.applyDraft(draft);
      state.navigatorTab.value = 'drafts';
      state.workspaceTab.value = 'overview';
      state.selectedSkill.value = null;
      toast.success('Skill Draft 已创建');
    } catch (error) {
      state.createDraftDialog.value.error = error?.message || '创建 Skill Draft 失败';
    } finally {
      state.creatingDraft.value = false;
    }
  }

  return {
    saveOverview,
    publishDraft,
    deleteDraft,
    editPublishedSkill,
    deletePublishedSkill,
    openCreateDraft,
    closeCreateDraft,
    createDraft,
    updateDraftForm,
  };
}
