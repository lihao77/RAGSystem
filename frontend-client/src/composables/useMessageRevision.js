import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { rollbackAndRetrySession } from '../api/session.js';
import { useSessionRunStore } from '../stores/session-run.js';
import { createAssistantMessage } from './useMessageExecution.js';
import { resetActiveRunForSend, serializeAttachmentForSend } from './useSessionAgentClient.js';

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
  const { messages, currentSessionId } = storeToRefs(sessionRunStore);
  const editingMessageIndex = ref(null);
  const editingDraft = ref('');
  const editingAttachmentsDraft = ref([]);
  const editingSubmitting = ref(false);

  const reloadMessagesAfterRetryFailure = async (sessionId) => {
    if (typeof deps.reloadSessionMessages !== 'function') return;
    try {
      await deps.reloadSessionMessages(sessionId);
    } catch (reloadError) {
      console.warn('重试失败后刷新会话消息失败:', reloadError);
    }
  };

  const projectRetriedRun = ({ sessionId, index, content, attachments, result, retrySource }) => {
    const retryMetadata = {
      execution_kind: 'rollback_and_retry',
      ...(result.request_id ? { request_id: result.request_id } : {}),
      ...(result.run_id ? { run_id: result.run_id } : {}),
      ...(retrySource?.seq != null ? { retry_of_seq: retrySource.seq } : {}),
      ...(retrySource?.id ? { retry_of_message_id: retrySource.id } : {}),
    };
    const retriedUserMessage = {
      role: 'user',
      content,
      attachments,
      metadata: retryMetadata,
    };
    messages.value = [
      ...messages.value.slice(0, index),
      retriedUserMessage,
      createAssistantMessage({ run_id: result.run_id }),
    ];
    const assistantMsgIndex = messages.value.length - 1;
    resetActiveRunForSend(deps.activeRun, assistantMsgIndex);
    deps.activeRun.runId = result.run_id;
    sessionRunStore.beginOptimisticCommand('send');
    deps.cacheMessages(sessionId, messages.value);
    deps.stickToBottom?.();
  };

  const editingMessage = computed(() => {
    const index = editingMessageIndex.value;
    if (index == null || index < 0) return null;
    return messages.value[index] || null;
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
    const foundIndex = messages.value.findIndex(item => item === msg);
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
    const msg = messages.value[index];
    if (!msg || msg.role !== 'user') {
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
      const resp = await (deps.chatSdkClient?.rollbackAndRetrySession
        ? deps.chatSdkClient.rollbackAndRetrySession(sessionId, retryBody)
        : rollbackAndRetrySession(sessionId, retryBody));
      const result = resp.data || {};
      if (!result.started) {
        throw new Error(result.error || '操作失败');
      }

      if (result.kind === 'command') {
        await deps.reloadSessionMessages?.(sessionId);
        resetEditingState();
        return;
      }
      projectRetriedRun({ sessionId, index, content, attachments: materialized, result, retrySource: msg });
      resetEditingState();
    } catch (error) {
      editingSubmitting.value = false;
      await reloadMessagesAfterRetryFailure(sessionId);
      deps.showToast(error.message || '操作失败');
    }
  };

  const rollbackAndRetry = async (msg) => {
    const sessionId = currentSessionId.value;
    if (!sessionId) {
      deps.showToast('当前无会话');
      return;
    }
    if (msg.role !== 'user') {
      deps.showToast('仅支持从用户消息重试');
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

    try {
      // 原样重试：不传 modify_user_message/attachments，后端用原消息内容与原附件
      const resp = await (deps.chatSdkClient?.rollbackAndRetrySession
        ? deps.chatSdkClient.rollbackAndRetrySession(sessionId, anchor)
        : rollbackAndRetrySession(sessionId, anchor));
      const result = resp.data || {};
      if (!result.started) {
        throw new Error(result.error || '重试失败');
      }
      if (result.kind === 'command') {
        await deps.reloadSessionMessages?.(sessionId);
        return;
      }
      projectRetriedRun({
        sessionId,
        index,
        content: msg.content || '',
        attachments: Array.isArray(msg.attachments) ? msg.attachments : [],
        result,
        retrySource: msg,
      });
    } catch (error) {
      await reloadMessagesAfterRetryFailure(sessionId);
      deps.showToast(error.message || '重试失败');
    }
  };

  return {
    editingMessage,
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
