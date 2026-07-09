import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { rollbackAndRetrySession } from '../api/session.js';
import { useSessionRunStore } from '../stores/session-run.js';
import { createAssistantMessage } from './useMessageExecution.js';
import { resetActiveRunForSend, serializeAttachmentForSend } from './useSessionAgentClient.js';

/**
 * 构造 rollback-and-retry 的锚点：指向被编辑/重试的用户消息本身（messages[index]）。
 * 后端 prepareRetry 用 after 定位被改写的 user 消息，故锚点必须指向自身，而不是前一条
 * （旧的指向前一条的语义是为"裸 rollback 删 index 及之后 + 重发新消息"两步走服务的，与原子端点不符）。
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
  const { messages, currentSessionId } = storeToRefs(useSessionRunStore());
  const editingMessageIndex = ref(null);
  const editingDraft = ref('');
  const editingAttachmentsDraft = ref([]);
  const editingSubmitting = ref(false);

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
    if (deps.isLoading.value) {
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
      // 物化附件（上传本地文件拿 file_id）后整体随原子端点提交
      const materialized = await deps.materializeAttachmentsForSend(draftAttachments, sessionId);
      const selectedLlm = deps.getCurrentSelectedLlm?.();
      const resp = await rollbackAndRetrySession(sessionId, {
        ...anchor,
        modify_user_message: content,
        attachments: materialized.map(serializeAttachmentForSend),
        ...(selectedLlm ? { selected_llm: selectedLlm } : {}),
      });
      const result = resp.data || {};
      if (!result.started) {
        throw new Error(result.error || '操作失败');
      }

      // 本地同步：保留被编辑消息（更新内容/附件，id/seq 不变），删其后回复，push 新 assistant 占位。
      // HTTP 成功才动本地；失败时后端 prepareRetry/startRun 同事务，要么全成要么全不成，本地无须回滚。
      messages.value = messages.value.slice(0, index + 1);
      const userMsg = messages.value[index];
      if (userMsg) {
        userMsg.content = content;
        userMsg.attachments = materialized;
      }
      const assistantMsgIndex = messages.value.push(createAssistantMessage({ run_id: result.run_id })) - 1;
      resetActiveRunForSend(deps.activeRun, assistantMsgIndex);
      deps.activeRun.runId = result.run_id;
      deps.isLoading.value = true;
      deps.cacheMessages(sessionId, messages.value);
      deps.stickToBottom?.();
      resetEditingState();
    } catch (error) {
      editingSubmitting.value = false;
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
    if (deps.isLoading.value) {
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
      const resp = await rollbackAndRetrySession(sessionId, anchor);
      const result = resp.data || {};
      if (!result.started) {
        throw new Error(result.error || '重试失败');
      }
      // 保留原 user 消息对象（id/seq 不变），删其后回复，push 新 assistant 占位
      messages.value = messages.value.slice(0, index + 1);
      const assistantMsgIndex = messages.value.push(createAssistantMessage({ run_id: result.run_id })) - 1;
      resetActiveRunForSend(deps.activeRun, assistantMsgIndex);
      deps.activeRun.runId = result.run_id;
      deps.isLoading.value = true;
      deps.cacheMessages(sessionId, messages.value);
      deps.stickToBottom?.();
    } catch (error) {
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
