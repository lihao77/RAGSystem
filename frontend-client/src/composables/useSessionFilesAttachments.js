import { computed, ref } from 'vue';
import {
  createLocalAttachment,
  formatAttachmentMeta,
  formatAttachmentSize,
  getAttachmentKey,
  getSessionFileDownloadUrl,
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
  const getPathForFile = deps.getPathForFile ?? ((file) =>
    typeof window !== 'undefined' ? window.ragsystemDesktop?.getPathForFile?.(file) || '' : '');
  // 部分登记成功后失败时，重试沿用已创建的引用；同一草稿不能跨会话复用引用。
  const materializedLocalAttachments = new Map();

  const forgetMaterializedAttachment = (attachment) => {
    if (!isLocalAttachment(attachment)) return;
    for (const [sessionId, files] of materializedLocalAttachments) {
      files.delete(attachment.local_id);
      if (!files.size) materializedLocalAttachments.delete(sessionId);
    }
  };

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
      forgetMaterializedAttachment(attachment);
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
      if (!deps.chatSdkClient) throw new Error('Chat SDK 未初始化');
      const res = await deps.chatSdkClient.listFiles(sessionId);
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

  // 选中文件（粘贴/拖放/抽屉上传）只就地加入待发送列表 + toast 反馈，不弹附件抽屉：
  // 粘贴发生在输入中途，弹管理抽屉会打断输入；附件卡已内联出现在输入框里，抽屉
  // 需要时由加号按钮显式打开。抽屉内上传时抽屉本就开着，无需在此维持可见态。
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
  };

  const materializeAttachmentsForSend = async (attachments, sessionId) => {
    const localAttachments = attachments.filter(isLocalAttachment);
    if (!localAttachments.length) {
      return attachments.map(normalizeSessionAttachment).filter(Boolean);
    }
    uploadingSessionFiles.value = true;
    try {
      if (!deps.chatSdkClient) throw new Error('Chat SDK 未初始化');
      const createdFiles = new Map();
      const uploads = [];
      const rememberCreatedFile = (attachment, file) => {
        let cachedFiles = materializedLocalAttachments.get(sessionId);
        if (!cachedFiles) {
          cachedFiles = new Map();
          materializedLocalAttachments.set(sessionId, cachedFiles);
        }
        cachedFiles.set(attachment.local_id, file);
        createdFiles.set(attachment.local_id, file);
      };
      for (const attachment of localAttachments) {
        const cached = materializedLocalAttachments.get(sessionId)?.get(attachment.local_id);
        if (cached) {
          createdFiles.set(attachment.local_id, cached);
          continue;
        }
        // 只有模型可内联的图片进入受管存储；TIFF 等格式按普通文件链接。
        const localPath = isImageAttachment(attachment) ? '' : getPathForFile(attachment.file);
        if (!localPath) {
          uploads.push(attachment);
          continue;
        }
        const res = await deps.chatSdkClient.linkLocalFile(sessionId, {
          path: localPath,
          original_name: attachment.original_name,
          mime: attachment.mime || 'application/octet-stream',
        });
        const linked = normalizeSessionAttachment(res.file);
        if (!linked) throw new Error('附件链接结果无效');
        rememberCreatedFile(attachment, linked);
      }
      if (uploads.length) {
        const res = await deps.chatSdkClient.uploadFiles(sessionId, uploads.map(attachment => attachment.file));
        const uploaded = (res.files || []).map(normalizeSessionAttachment).filter(Boolean);
        if (uploaded.length !== uploads.length) throw new Error('附件上传结果数量不匹配');
        uploads.forEach((attachment, index) => rememberCreatedFile(attachment, uploaded[index]));
      }
      const mapped = [];
      for (const attachment of attachments) {
        if (isLocalAttachment(attachment)) {
          mapped.push(createdFiles.get(attachment.local_id));
          revokeAttachmentPreviewUrl(attachment);
          // 全部成功后返回值已包含持久引用，缓存只服务物化过程中的失败重试。
          forgetMaterializedAttachment(attachment);
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

  const downloadSessionFileItem = async (file) => {
    if (!deps.currentSessionId.value || !file?.id) return;
    try {
      if (!deps.chatSdkClient) throw new Error('Chat SDK 未初始化');
      const response = await deps.chatSdkClient.downloadFile(deps.currentSessionId.value, file.id);
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = file.original_name || file.stored_name || file.id;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (error) {
      deps.showToast(error.message || '下载会话文件失败');
    }
  };

  const removeSessionFile = async (file) => {
    const sessionId = deps.currentSessionId.value;
    if (!sessionId || !file?.id) return;
    deletingSessionFileId.value = file.id;
    try {
      if (!deps.chatSdkClient) throw new Error('Chat SDK 未初始化');
      await deps.chatSdkClient.deleteFile(sessionId, file.id);
      const cachedFiles = materializedLocalAttachments.get(sessionId);
      if (cachedFiles) {
        for (const [localId, cached] of cachedFiles) {
          if ((cached.file_id || cached.id) === file.id) cachedFiles.delete(localId);
        }
        if (!cachedFiles.size) materializedLocalAttachments.delete(sessionId);
      }
      if (deps.currentSessionId.value === sessionId) {
        sessionFiles.value = sessionFiles.value.filter(item => item.id !== file.id);
      }
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
