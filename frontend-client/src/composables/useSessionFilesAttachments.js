import { computed, ref } from 'vue';
import { deleteSessionFile, getSessionFileDownloadUrl, listSessionFiles, uploadSessionFiles } from '../api/sessionFiles.js';
import {
  createLocalAttachment,
  formatAttachmentMeta,
  formatAttachmentSize,
  getAttachmentKey,
  isImageAttachment,
  isLocalAttachment,
  normalizeSessionAttachment,
  revokeAttachmentPreviewUrl,
} from '../utils/sessionAttachments.js';

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
    if (isLocalAttachment(attachment)) return attachment.preview_url || '';
    if (!deps.currentSessionId.value || !attachment?.file_id) return '';
    return getSessionFileDownloadUrl(deps.currentSessionId.value, attachment.file_id);
  };

  const dedupeAttachments = (list) => {
    const seen = new Set();
    return list.filter((attachment) => {
      const key = getAttachmentKey(attachment);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const releaseAttachmentResources = (attachments) => {
    for (const attachment of attachments || []) {
      revokeAttachmentPreviewUrl(attachment);
    }
  };

  const replaceComposerAttachments = (nextList) => {
    releaseAttachmentResources(
      pendingAttachments.value.filter(item => !nextList.some(next => getAttachmentKey(next) === getAttachmentKey(item)))
    );
    pendingAttachments.value = nextList;
  };

  const replaceEditingAttachments = (nextList) => {
    const prevList = deps.getEditingAttachmentsDraft?.() || [];
    releaseAttachmentResources(
      prevList.filter(item => !nextList.some(next => getAttachmentKey(next) === getAttachmentKey(item)))
    );
    deps.setEditingAttachmentsDraft(nextList);
  };

  const removeAttachmentFromList = (list, attachment) => {
    const targetKey = getAttachmentKey(attachment);
    return list.filter(item => getAttachmentKey(item) !== targetKey);
  };

  const currentDrawerPendingFiles = computed(() => {
    const editingAttachments = deps.getEditingAttachmentsDraft?.() || [];
    return sessionFilesDrawerTarget.value === 'message-edit'
      ? editingAttachments
      : pendingAttachments.value;
  });

  const removePendingAttachment = (attachment) => {
    replaceComposerAttachments(removeAttachmentFromList(pendingAttachments.value, attachment));
  };

  const removeEditingAttachment = (attachment) => {
    const editingAttachments = deps.getEditingAttachmentsDraft?.() || [];
    replaceEditingAttachments(removeAttachmentFromList(editingAttachments, attachment));
  };

  const reuseSessionFileAsAttachment = (file) => {
    const normalized = normalizeSessionAttachment(file);
    if (!normalized) return;
    const targetList = sessionFilesDrawerTarget.value === 'message-edit'
      ? (deps.getEditingAttachmentsDraft?.() || [])
      : pendingAttachments.value;
    const nextList = dedupeAttachments([...targetList, normalized]);
    if (sessionFilesDrawerTarget.value === 'message-edit') {
      replaceEditingAttachments(nextList);
    } else {
      replaceComposerAttachments(nextList);
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
    const nextAttachments = Array.from(files || [])
      .filter(file => file instanceof File)
      .map(createLocalAttachment)
      .filter(Boolean);
    if (!nextAttachments.length) return;
    const isEditingTarget = sessionFilesDrawerTarget.value === 'message-edit';
    const targetList = isEditingTarget
      ? (deps.getEditingAttachmentsDraft?.() || [])
      : pendingAttachments.value;
    const mergedFiles = dedupeAttachments([...targetList, ...nextAttachments]);
    if (isEditingTarget) {
      replaceEditingAttachments(mergedFiles);
    } else {
      replaceComposerAttachments(mergedFiles);
    }
    deps.showToast(`已添加 ${nextAttachments.length} 个待发送附件`, 'success');
    sessionFilesDrawerVisible.value = true;
  };

  const materializeAttachmentsForSend = async (attachments, sessionId) => {
    const localAttachments = attachments.filter(isLocalAttachment);
    if (!localAttachments.length) {
      return attachments.map(normalizeSessionAttachment).filter(Boolean);
    }
    const fd = new FormData();
    for (const attachment of localAttachments) {
      fd.append('files', attachment.file);
    }
    uploadingSessionFiles.value = true;
    try {
      const res = await uploadSessionFiles(sessionId, fd);
      const createdFiles = (res.files || []).map(normalizeSessionAttachment).filter(Boolean);
      if (createdFiles.length !== localAttachments.length) {
        throw new Error('附件上传结果数量不匹配');
      }
      const mapped = [];
      let localIndex = 0;
      for (const attachment of attachments) {
        if (isLocalAttachment(attachment)) {
          mapped.push(createdFiles[localIndex]);
          revokeAttachmentPreviewUrl(attachment);
          localIndex += 1;
        } else {
          const normalized = normalizeSessionAttachment(attachment);
          if (normalized) mapped.push(normalized);
        }
      }
      await loadSessionFiles(sessionId);
      return mapped;
    } catch (error) {
      console.error('materializeAttachmentsForSend failed:', { sessionId, attachmentCount: localAttachments.length, error });
      throw error;
    } finally {
      uploadingSessionFiles.value = false;
    }
  };

  const clearComposerAttachments = () => {
    replaceComposerAttachments([]);
  };

  const clearEditingAttachments = () => {
    replaceEditingAttachments([]);
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
    normalizeAttachment: normalizeSessionAttachment,
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
    materializeAttachmentsForSend,
    clearComposerAttachments,
    clearEditingAttachments,
    downloadSessionFileItem,
    removeSessionFile,
  };
}
