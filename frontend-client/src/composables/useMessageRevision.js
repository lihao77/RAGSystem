import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';
import { createRequestId, serializeAttachmentForSend } from './useSessionAgentClient.js';
import { getUserDisplayText } from '../utils/messageContentParts.js';

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
    editingDraft.value = getUserDisplayText(msg);
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
    let stopAcceptWatch = null;
    let accepted = false;
    try {
      // 先物化附件（上传本地文件拿 file_id），再交给后端执行“回滚 -> 统一发送”。
      const materialized = await deps.materializeAttachmentsForSend(draftAttachments, sessionId);
      const selectedLlm = deps.getCurrentSelectedLlm?.();
      const thinkingLevel = deps.getCurrentThinkingLevel?.();
      const retryBody = {
        ...anchor,
        modify_user_message: content,
        attachments: materialized.map(serializeAttachmentForSend),
        ...(selectedLlm ? { selected_llm: selectedLlm } : {}),
        ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
      };
      if (!deps.chatSdkClient) throw new Error('Chat SDK 未初始化');
      const requestId = createRequestId();
      sessionRunStore.beginPendingCommand('rollback', requestId);
      rollbackRequested = true;
      const request = deps.chatSdkClient.rollbackAndRetrySession(
        sessionId,
        retryBody,
        { requestId },
      );
      // 命令路径（如 /compact）整个跑在本次 HTTP 请求内，数十秒才返回；期间编辑框不能一直
      // 卡"提交中"，列表也不能停留在"未回滚的旧历史 + 尾部新消息"的双重视图。新消息被接受
      // （message_saved 携带 request_id → finishPendingCommand 移除本项）即代表回滚已落定：
      // 立即关编辑框并重载权威视图，不等响应返回；失败兜底仍由 catch 承接（toast + 重载）。
      stopAcceptWatch = watch(
        () => sessionRunStore.pendingCommands.some(item => item.request_id === requestId),
        (stillPending) => {
          if (stillPending || accepted) return;
          accepted = true;
          if (currentSessionId.value !== sessionId || !editingTarget.value) return;
          void reloadCanonicalSessionState(sessionId);
          resetEditingState();
        },
      );
      const resp = await request;
      const result = resp.data || {};
      if (!result.started) {
        throw new Error(result.error || '操作失败');
      }

      if (!accepted) {
        await reloadCanonicalSessionState(sessionId);
        resetEditingState();
      }
      sessionRunStore.finishPendingCommand(requestId);
    } catch (error) {
      stopAcceptWatch?.();
      editingSubmitting.value = false;
      // 接受路径已重载过权威视图（命令被停止/失败时 command_result 文案也在其中）；
      // 未接受（请求前置失败）才需要 catch 里的恢复性重载，避免双重视图二次刷新。
      if (rollbackRequested && !accepted) await reloadCanonicalSessionState(sessionId);
      sessionRunStore.finishPendingCommand();
      deps.showToast(error.message || '操作失败');
    } finally {
      stopAcceptWatch?.();
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
