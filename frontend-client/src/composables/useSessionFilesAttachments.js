import { computed, ref } from 'vue';
import { deleteSessionFile, getSessionFileDownloadUrl, listSessionFiles, uploadSessionFiles } from '../api/sessionFiles';
import { formatAttachmentMeta, formatAttachmentSize, isImageAttachment, normalizeAttachment } from '../utils/sessionAttachments';

/**
 * 会话文件与消息附件状态管理。
 * 保留现有模板结构，仅抽离数据流与动作。
 */
export function useSessionFilesAttachments(deps) {
  const sessionFiles = ref([]);
  const pendingAttachments = ref([]);
  const sessionFilesLoading = ref(false);
  const uploadingSessionFiles = ref(false);
  const deletingSessionFileId = ref(null);
  const sessionFilesDrawerVisible = deps.sessionFilesDrawerVisible || ref(false);
  const sessionFilesDrawerTarget = deps.sessionFilesDrawerTarget || ref('composer');

  const getAttachmentPreviewUrl = (attachment) => {
    if (!deps.currentSessionId.value || !attachment?.file_id) return '';
    return getSessionFileDownloadUrl(deps.currentSessionId.value, attachment.file_id);
  };

  const removeAttachmentFromList = (list, attachment) => {
    const fileId = attachment?.file_id || attachment?.id;
    return list.filter(item => (item.file_id || item.id) !== fileId);
  };

  const currentDrawerPendingFiles = computed(() => {
    const editingAttachments = deps.getEditingAttachmentsDraft?.() || [];
    return sessionFilesDrawerTarget.value === 'message-edit'
      ? editingAttachments
      : pendingAttachments.value;
  });

  const removePendingAttachment = (attachment) => {
    pendingAttachments.value = removeAttachmentFromList(pendingAttachments.value, attachment);
  };

  const removeEditingAttachment = (attachment) => {
    const editingAttachments = deps.getEditingAttachmentsDraft?.() || [];
    deps.setEditingAttachmentsDraft(removeAttachmentFromList(editingAttachments, attachment));
  };

  const reuseSessionFileAsAttachment = (file) => {
    const normalized = normalizeAttachment(file);
    if (!normalized) return;
    const targetList = sessionFilesDrawerTarget.value === 'message-edit'
      ? (deps.getEditingAttachmentsDraft?.() || [])
      : pendingAttachments.value;
    const fileId = normalized.file_id;
    if (!targetList.some(item => (item.file_id || item.id) === fileId)) {
      const nextList = [...targetList, normalized];
      if (sessionFilesDrawerTarget.value === 'message-edit') {
        deps.setEditingAttachmentsDraft(nextList);
      } else {
        pendingAttachments.value = nextList;
      }
    }
    sessionFilesDrawerVisible.value = false;
    sessionFilesDrawerTarget.value = 'composer';
  };

  const loadSessionFiles = async (sessionId) => {
    if (!sessionId) {
      sessionFiles.value = [];
      return;
    }
    sessionFilesLoading.value = true;
    try {
      const res = await listSessionFiles(sessionId);
      if (deps.currentSessionId.value !== sessionId) return;
      sessionFiles.value = res.files || [];
    } catch (error) {
      deps.showToast(error.message || '加载会话文件失败');
    } finally {
      sessionFilesLoading.value = false;
    }
  };

  const openSessionFilesDrawer = (target = 'composer') => {
    sessionFilesDrawerTarget.value = target;
    if (deps.currentSessionId.value) {
      loadSessionFiles(deps.currentSessionId.value);
    }
    sessionFilesDrawerVisible.value = true;
  };

  const handleSessionFileSelect = async (filesOrEvent) => {
    const files = filesOrEvent?.target?.files || filesOrEvent;
    const normalizedFiles = Array.from(files || []).filter(file => file instanceof File);
    if (!normalizedFiles.length) return;
    const sessionId = await deps.ensureSession();
    if (!sessionId) return;

    const fd = new FormData();
    for (const file of normalizedFiles) fd.append('files', file);

    uploadingSessionFiles.value = true;
    try {
      const res = await uploadSessionFiles(sessionId, fd);
      const createdFiles = (res.files || []).map(normalizeAttachment).filter(Boolean);
      const isEditingTarget = sessionFilesDrawerTarget.value === 'message-edit';
      const editingAttachments = deps.getEditingAttachmentsDraft?.() || [];
      const targetList = isEditingTarget ? editingAttachments : pendingAttachments.value;
      const mergedFiles = [
        ...targetList,
        ...createdFiles.filter(file => !targetList.some(item => (item.file_id || item.id) === file.file_id)),
      ];
      if (isEditingTarget) {
        deps.setEditingAttachmentsDraft(mergedFiles);
      } else {
        pendingAttachments.value = mergedFiles;
      }
      deps.showToast(`已添加 ${res.files?.length || 0} 个附件`, 'success');
      await loadSessionFiles(sessionId);
      sessionFilesDrawerVisible.value = true;
    } catch (error) {
      console.error('handleSessionFileSelect failed:', { sessionId, fileCount: normalizedFiles.length, error });
      deps.showToast(error.message || '上传会话文件失败');
    } finally {
      uploadingSessionFiles.value = false;
    }
  };

  const downloadSessionFileItem = (file) => {
    if (!deps.currentSessionId.value || !file?.id) return;
    window.open(getSessionFileDownloadUrl(deps.currentSessionId.value, file.id), '_blank');
  };

  const removeSessionFile = async (file) => {
    if (!deps.currentSessionId.value || !file?.id) return;
    deletingSessionFileId.value = file.id;
    try {
      await deleteSessionFile(deps.currentSessionId.value, file.id);
      sessionFiles.value = sessionFiles.value.filter(item => item.id !== file.id);
      deps.showToast('会话文件已删除', 'success');
    } catch (error) {
      deps.showToast(error.message || '删除会话文件失败');
    } finally {
      deletingSessionFileId.value = null;
    }
  };

  return {
    sessionFiles,
    pendingAttachments,
    sessionFilesLoading,
    uploadingSessionFiles,
    deletingSessionFileId,
    sessionFilesDrawerVisible,
    sessionFilesDrawerTarget,
    normalizeAttachment,
    isImageAttachment,
    formatAttachmentSize,
    formatAttachmentMeta,
    getAttachmentPreviewUrl,
    currentDrawerPendingFiles,
    removePendingAttachment,
    removeEditingAttachment,
    reuseSessionFileAsAttachment,
    loadSessionFiles,
    openSessionFilesDrawer,
    handleSessionFileSelect,
    downloadSessionFileItem,
    removeSessionFile,
  };
}
