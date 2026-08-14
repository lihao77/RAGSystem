/**
 * Skill Draft bundle 文件动作：保存/删除/上传/创建/下载。
 * 文件选中与读取在 useSkillLibrary.selectDraftFile（选中属于导航编排）。
 */

import { deleteSkillDraftFile, putSkillDraftFile } from '../../api/skillLibrary.js';
import { decodeBase64Bytes, encodeBase64Text, readFileAsBase64 } from '../../utils/base64.js';
import { guessMediaType, isValidRelativePath } from '../../utils/skillFiles.js';

export function useSkillDraftFiles(state, library, { toast, confirm }) {
  async function saveSelectedFile() {
    if (!state.activeDraft.value || !state.selectedFile.value || !state.fileDirty.value || !state.canEditSkillDraft.value) return;
    const current = state.activeDraft.value;
    state.fileSaving.value = true;
    state.workspaceError.value = '';
    try {
      const updated = await putSkillDraftFile(current.id, current.revision, {
        relative_path: state.selectedFile.value.relative_path,
        media_type: state.selectedFile.value.media_type,
        body_base64: encodeBase64Text(state.fileText.value),
      });
      library.applyDraft(updated);
      state.originalFileText.value = state.fileText.value;
      state.selectedFile.value = {
        ...state.selectedFile.value,
        ...updated.bundle_assets.find((asset) => asset.relative_path === state.selectedFilePath.value),
        body_base64: encodeBase64Text(state.fileText.value),
      };
      await library.syncPublishedState(updated);
      toast.success(updated.status === 'published' ? '文件已保存并自动发布' : 'Draft 文件已保存');
    } catch (error) {
      state.workspaceError.value = error?.message || '保存 Draft 文件失败';
      if (error?.status === 409) await library.recoverDraft(current.id);
    } finally {
      state.fileSaving.value = false;
    }
  }

  async function deleteSelectedFile() {
    if (!state.activeDraft.value || !state.selectedFile.value || state.selectedFile.value.relative_path === 'SKILL.md') return;
    const current = state.activeDraft.value;
    const relativePath = state.selectedFile.value.relative_path;
    const accepted = await confirm({
      title: '删除 bundle 文件',
      message: `确认从 Draft 删除“${relativePath}”？`,
      confirmText: '删除文件',
      danger: true,
    });
    if (!accepted) return;
    state.fileDeleting.value = true;
    state.workspaceError.value = '';
    try {
      const updated = await deleteSkillDraftFile(current.id, current.revision, relativePath);
      library.applyDraft(updated);
      library.resetFileEditor();
      await library.selectDraftFile('SKILL.md', { skipGuard: true });
      await library.syncPublishedState(updated);
      toast.success(updated.status === 'published' ? '文件已删除并自动发布' : 'Draft 文件已删除');
    } catch (error) {
      state.workspaceError.value = error?.message || '删除 Draft 文件失败';
      if (error?.status === 409) await library.recoverDraft(current.id);
    } finally {
      state.fileDeleting.value = false;
    }
  }

  async function uploadSelectedFile(event) {
    const input = event.target;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !state.activeDraft.value) return;
    const relativePath = file.webkitRelativePath || file.name;
    if (!isValidRelativePath(relativePath)) {
      state.workspaceError.value = '文件路径无效';
      return;
    }
    const existing = state.activeDraft.value.bundle_assets.some((asset) => asset.relative_path.toLowerCase() === relativePath.toLowerCase());
    if (existing) {
      const accepted = await confirm({
        title: '替换 bundle 文件',
        message: `“${relativePath}”已存在，确认使用上传文件替换？`,
        confirmText: '替换',
        danger: false,
      });
      if (!accepted) return;
    }
    const current = state.activeDraft.value;
    state.fileSaving.value = true;
    state.workspaceError.value = '';
    try {
      const updated = await putSkillDraftFile(current.id, current.revision, {
        relative_path: relativePath,
        media_type: file.type || guessMediaType(relativePath),
        body_base64: await readFileAsBase64(file),
      });
      library.applyDraft(updated);
      await library.selectDraftFile(relativePath, { skipGuard: true });
      await library.syncPublishedState(updated);
      toast.success(updated.status === 'published' ? '文件已上传并自动发布' : '文件已加入 Draft');
    } catch (error) {
      state.workspaceError.value = error?.message || '上传 Draft 文件失败';
      if (error?.status === 409) await library.recoverDraft(current.id);
    } finally {
      state.fileSaving.value = false;
    }
  }

  function openCreateFile() {
    state.createFileDialog.value = { open: true, path: '', content: '', error: '' };
  }

  function closeCreateFile() {
    if (state.fileSaving.value) return;
    state.createFileDialog.value.open = false;
    state.createFileDialog.value.error = '';
  }

  async function createTextFile() {
    if (!state.activeDraft.value || !state.canCreateFile.value) return;
    const current = state.activeDraft.value;
    const relativePath = state.createFileDialog.value.path.replaceAll('\\', '/');
    if (current.bundle_assets.some((asset) => asset.relative_path.toLowerCase() === relativePath.toLowerCase())) {
      state.createFileDialog.value.error = '同名文件已存在，请在文件树中打开后编辑。';
      return;
    }
    state.fileSaving.value = true;
    state.createFileDialog.value.error = '';
    try {
      const updated = await putSkillDraftFile(current.id, current.revision, {
        relative_path: relativePath,
        media_type: guessMediaType(relativePath),
        body_base64: encodeBase64Text(state.createFileDialog.value.content),
      });
      library.applyDraft(updated);
      state.createFileDialog.value.open = false;
      await library.selectDraftFile(relativePath, { skipGuard: true });
      await library.syncPublishedState(updated);
      toast.success(updated.status === 'published' ? '文件已创建并自动发布' : '文本文件已创建');
    } catch (error) {
      state.createFileDialog.value.error = error?.message || '创建 Draft 文件失败';
      if (error?.status === 409) await library.recoverDraft(current.id);
    } finally {
      state.fileSaving.value = false;
    }
  }

  function downloadSelectedFile() {
    if (!state.selectedFile.value?.body_base64) return;
    const bytes = decodeBase64Bytes(state.selectedFile.value.body_base64);
    const blob = new Blob([bytes], { type: state.selectedFile.value.media_type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = state.selectedFile.value.relative_path.split('/').pop() || 'skill-file';
    link.click();
    URL.revokeObjectURL(url);
  }

  function setFileText(value) {
    state.fileText.value = value;
  }

  return {
    saveSelectedFile,
    deleteSelectedFile,
    uploadSelectedFile,
    openCreateFile,
    closeCreateFile,
    createTextFile,
    downloadSelectedFile,
    setFileText,
  };
}
