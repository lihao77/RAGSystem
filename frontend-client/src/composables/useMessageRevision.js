import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';
import { createRequestId, serializeAttachmentForSend } from './useSessionAgentClient.js';

/**
 * 构造 rollback-and-retry 的锚点：指向被编辑/重试的用户消息本身（messages[index]）。
 * 后端会删除该锚点及其后历史，再通过统一用户消息入口创建一条新消息。
 * 返回 null 表示该消息尚未持久化（无 id/seq），调用方应拦截。
 */
function buildRetryAnchorBody(messages, index) {
  const target = messages[index];
  if (!target) return null;
  if (target.id) return { after_message_id: target.id };
  if (target.seq != null) return { after_seq: target.seq };
  return null;
}

/**
 * 用户消息编辑、回滚与重发状态机。
 * 保持消息模板骨架不变，只抽脚本流程。
 */
export function useMessageRevision(deps) {
  const sessionRunStore = useSessionRunStore();
  const { messages, currentSessionId, selectedParticipantId } = storeToRefs(sessionRunStore);
  const editingTarget = ref(null);
  const editingDraft = ref('');
  const editingAttachmentsDraft = ref([]);
  const editingSubmitting = ref(false);

  const reloadCanonicalSessionState = async (sessionId) => {
    deps.deleteMessageCache?.(sessionId);
    sessionRunStore.clearChildParticipantMessages();
    const reloads = [
      [deps.reloadSessionMessages, [sessionId, { preserveStream: true }], '会话消息'],
      [deps.reloadSessionParticipants, [sessionId, { silent: true }], '智能体列表'],
    ];
    await Promise.all(reloads.map(async ([reload, args, label]) => {
      if (typeof reload !== 'function') return;
      try {
        await reload(...args);
      } catch (reloadError) {
        console.warn(`刷新回滚后的${label}失败:`, reloadError);
      }
    }));
  };

  const editingMessage = computed(() => {
    const target = editingTarget.value;
    if (!target || target.participantId !== selectedParticipantId.value) return null;
    return messages.value.find(message => message?.id === target.messageId) || null;
  });

  const canReviseMessage = msg => Boolean(
    selectedParticipantId.value === 'root'
    && msg?.role === 'user'
    && msg?.metadata?.agent_message !== true
    && msg?.id
    && messages.value.some(message => message === msg || message?.id === msg.id)
  );

  const resetEditingState = ({ closeDrawer = true } = {}) => {
    editingTarget.value = null;
    editingDraft.value = '';
    editingAttachmentsDraft.value = [];
    editingSubmitting.value = false;
    if (closeDrawer && deps.sessionFilesDrawerTarget.value === 'message-edit') {
      deps.sessionFilesDrawerVisible.value = false;
    }
    deps.sessionFilesDrawerTarget.value = 'composer';
  };

  watch([selectedParticipantId, currentSessionId], () => resetEditingState(), { flush: 'sync' });

  const startEditMessage = (msg) => {
    if (!canReviseMessage(msg)) return;
    editingTarget.value = {
      participantId: selectedParticipantId.value,
      messageId: msg.id,
    };
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
    if (!editingTarget.value || editingSubmitting.value) return;
    const msg = editingMessage.value;
    const index = msg ? messages.value.findIndex(item => item?.id === msg.id) : -1;
    if (index < 0 || !canReviseMessage(msg)) {
      cancelEdit();
      return;
    }

    const content = (editingDraft.value || '').trim();
    const draftAttachments = editingAttachmentsDraft.value.slice();
    if (!content && !draftAttachments.length) {
      deps.showToast('内容和附件不能同时为空');
      return;
    }

    const sessionId = currentSessionId.value;
    if (!sessionId) {
      cancelEdit();
      return;
    }
    if (!sessionRunStore.allowsRuntimeAction('start_maintenance')) {
      deps.showToast('请先停止当前任务', 'warning');
      return;
    }
    const anchor = buildRetryAnchorBody(messages.value, index);
    if (!anchor) {
      deps.showToast('消息尚未持久化，无法重试');
      return;
    }

    editingSubmitting.value = true;
    let rollbackRequested = false;
    try {
      // 先物化附件（上传本地文件拿 file_id），再交给后端执行“回滚 -> 统一发送”。
      const materialized = await deps.materializeAttachmentsForSend(draftAttachments, sessionId);
      const selectedLlm = deps.getCurrentSelectedLlm?.();
      const retryBody = {
        ...anchor,
        modify_user_message: content,
        attachments: materialized.map(serializeAttachmentForSend),
        ...(selectedLlm ? { selected_llm: selectedLlm } : {}),
      };
      if (!deps.chatSdkClient) throw new Error('Chat SDK 未初始化');
      const requestId = createRequestId();
      sessionRunStore.beginPendingCommand('rollback', requestId);
      rollbackRequested = true;
      const resp = await deps.chatSdkClient.rollbackAndRetrySession(
        sessionId,
        retryBody,
        { requestId },
      );
      const result = resp.data || {};
      if (!result.started) {
        throw new Error(result.error || '操作失败');
      }

      await reloadCanonicalSessionState(sessionId);
      sessionRunStore.finishPendingCommand(requestId);
      resetEditingState();
    } catch (error) {
      editingSubmitting.value = false;
      if (rollbackRequested) await reloadCanonicalSessionState(sessionId);
      sessionRunStore.finishPendingCommand();
      deps.showToast(error.message || '操作失败');
    }
  };

  const rollbackAndRetry = async (msg) => {
    const sessionId = currentSessionId.value;
    if (!sessionId) {
      deps.showToast('当前无会话');
      return;
    }
    if (!canReviseMessage(msg)) {
      deps.showToast('仅支持从根会话中的用户消息重试');
      return;
    }
    if (!sessionRunStore.allowsRuntimeAction('start_maintenance')) {
      deps.showToast('请先停止当前任务', 'warning');
      return;
    }

    const index = messages.value.findIndex(item => item === msg || (item.role === 'user' && item.seq === msg.seq));
    if (index < 0) return;
    const anchor = buildRetryAnchorBody(messages.value, index);
    if (!anchor) {
      deps.showToast('消息尚未持久化，无法重试');
      return;
    }

    let rollbackRequested = false;
    try {
      // 原样重试：不传 modify_user_message/attachments，后端用原消息内容与原附件
      if (!deps.chatSdkClient) throw new Error('Chat SDK 未初始化');
      const requestId = createRequestId();
      sessionRunStore.beginPendingCommand('rollback', requestId);
      rollbackRequested = true;
      const resp = await deps.chatSdkClient.rollbackAndRetrySession(
        sessionId,
        anchor,
        { requestId },
      );
      const result = resp.data || {};
      if (!result.started) {
        throw new Error(result.error || '重试失败');
      }
      await reloadCanonicalSessionState(sessionId);
      sessionRunStore.finishPendingCommand(requestId);
    } catch (error) {
      if (rollbackRequested) await reloadCanonicalSessionState(sessionId);
      sessionRunStore.finishPendingCommand();
      deps.showToast(error.message || '重试失败');
    }
  };

  return {
    editingMessage,
    editingDraft,
    editingAttachmentsDraft,
    editingSubmitting,
    canReviseMessage,
    startEditMessage,
    resetEditingState,
    cancelEdit,
    confirmEditAndResend,
    rollbackAndRetry,
  };
}
