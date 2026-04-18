import { computed, nextTick, ref } from 'vue';

function buildRollbackBody(messages, index) {
  if (index === 0) return { after_seq: -1 };
  const prev = messages[index - 1];
  if (prev?.id) return { after_message_id: prev.id };
  if (prev?.seq != null) return { after_seq: prev.seq };
  return { after_seq: -1 };
}

/**
 * 用户消息编辑、回滚与重发状态机。
 * 保持消息模板骨架不变，只抽脚本流程。
 */
export function useMessageRevision(deps) {
  const editingMessageIndex = ref(null);
  const editingDraft = ref('');
  const editingAttachmentsDraft = ref([]);
  const editingSubmitting = ref(false);

  const editingMessage = computed(() => {
    const index = editingMessageIndex.value;
    if (index == null || index < 0) return null;
    return deps.messages.value[index] || null;
  });

  const resetEditingState = ({ closeDrawer = true } = {}) => {
    editingMessageIndex.value = null;
    editingDraft.value = '';
    editingAttachmentsDraft.value = [];
    editingSubmitting.value = false;
    if (closeDrawer && deps.sessionFilesDrawerTarget.value === 'message-edit') {
      deps.sessionFilesDrawerVisible.value = false;
    }
    deps.sessionFilesDrawerTarget.value = 'composer';
  };

  const startEditMessage = (msg, index) => {
    if (!msg || msg.role !== 'user') return;
    const foundIndex = deps.messages.value.findIndex(item => item === msg);
    editingMessageIndex.value = foundIndex >= 0 ? foundIndex : index;
    editingDraft.value = msg.content || '';
    editingAttachmentsDraft.value = Array.isArray(msg.attachments)
      ? msg.attachments.map(deps.normalizeAttachment).filter(Boolean)
      : [];
    editingSubmitting.value = false;
    deps.sessionFilesDrawerTarget.value = 'composer';
  };

  const cancelEdit = () => {
    if (editingSubmitting.value) return;
    resetEditingState();
  };

  const confirmEditAndResend = async () => {
    const index = editingMessageIndex.value;
    if (index == null || editingSubmitting.value) return;
    const msg = deps.messages.value[index];
    if (!msg || msg.role !== 'user') {
      cancelEdit();
      return;
    }

    const content = (editingDraft.value || '').trim();
    const attachments = editingAttachmentsDraft.value.slice();
    if (!content && !attachments.length) {
      deps.showToast('内容和附件不能同时为空');
      return;
    }

    const sessionId = deps.currentSessionId.value;
    if (!sessionId) {
      cancelEdit();
      return;
    }

    editingSubmitting.value = true;
    try {
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildRollbackBody(deps.messages.value, index)),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || '回退失败');
      }
      await deps.handleSend({ content, attachments, replaceFromIndex: index, clearEditing: true });
    } catch (error) {
      editingSubmitting.value = false;
      deps.showToast(error.message || '操作失败');
    }
  };

  const rollbackAndRetry = async (msg) => {
    const sessionId = deps.currentSessionId.value;
    if (!sessionId) {
      deps.showToast('当前无会话');
      return;
    }
    if (msg.role !== 'user' || msg.seq == null) {
      deps.showToast('仅支持从用户消息重试，且需已加载序号');
      return;
    }

    const index = deps.messages.value.findIndex(item => item === msg || (item.role === 'user' && item.seq === msg.seq));
    if (index < 0) return;

    const prevMessages = deps.messages.value.slice();
    try {
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildRollbackBody(deps.messages.value, index)),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || '回退失败');
      }
      deps.messages.value = deps.messages.value.slice(0, index);
      deps.cacheMessages(sessionId, deps.messages.value);
      deps.inputMessage.value = (msg.content || '').trim();
      await nextTick();
      deps.handleSend();
    } catch (error) {
      deps.messages.value = prevMessages;
      deps.cacheMessages(sessionId, prevMessages);
      deps.showToast(error.message || '回退失败');
    }
  };

  return {
    editingMessage,
    editingMessageIndex,
    editingDraft,
    editingAttachmentsDraft,
    editingSubmitting,
    startEditMessage,
    resetEditingState,
    cancelEdit,
    confirmEditAndResend,
    rollbackAndRetry,
  };
}
