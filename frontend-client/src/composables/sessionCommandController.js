// @ts-check
import { nextTick, ref } from 'vue';
import { createUserContentParts } from '../utils/messageContentParts.js';

/** @typedef {Record<string, any>} AnyRecord */
/** @param {unknown} error */
const errorMessage = error => error instanceof Error ? error.message : String(error);

/** @param {AnyRecord} attachment */
export const serializeAttachmentForSend = ({ file_id }) => ({ file_id });

export const createRequestId = () => globalThis.crypto?.randomUUID?.()
  || `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** @param {string} content @param {AnyRecord[]} attachments @param {AnyRecord} [metadata] @returns {import('./sessionCoreTypes.js').SessionMessage} */
export const createUserMessage = (content, attachments, metadata = {}) => ({
  role: 'user',
  content,
  content_parts: createUserContentParts(content, attachments),
  attachments,
  finished: true,
  has_execution: false,
  executionTree: { root: null, steps: [] },
  executionStepsLoaded: false,
  executionStepsLoading: false,
  executionStepsLoadError: '',
  _execState: null,
  metadata: { ...metadata },
});

/** @param {import('./sessionCoreTypes.js').SessionCommandControllerOptions} options */
export function createSessionCommandController({
  deps,
  currentSessionId,
  isLoading,
  allowsRuntimeAction,
  getSessionRuntime,
  beginPendingCommand,
  finishPendingCommand,
  scheduleCommandFallback,
  sendViaSdk,
  stopViaSdk,
}) {
  const lastFailedSendContent = ref('');
  /** @type {Promise<void>} */
  let sendQueue = Promise.resolve();
  /** @returns {void} */
  const settleSendQueue = () => {};

  const stop = async () => {
    if (!currentSessionId.value || !allowsRuntimeAction('stop_run')) return;
    try {
      if (!stopViaSdk) throw new Error('Chat SDK 未初始化');
      await stopViaSdk(currentSessionId.value);
    } catch (error) {
      console.warn('停止请求发送失败:', error);
    }
  };

  /** @param {{ content?: string, attachments?: AnyRecord[] } | null} [payload] */
  const sendNow = async (payload = null) => {
    const content = (payload?.content ?? deps.inputMessage.value).trim();
    const draftAttachments = Array.isArray(payload?.attachments)
      ? payload.attachments.slice()
      : deps.pendingAttachments.value.slice();
    let isRunningFollowup = Boolean(currentSessionId.value && allowsRuntimeAction('send_followup'));
    const canStartRun = !currentSessionId.value || allowsRuntimeAction('send_message');
    if (!isRunningFollowup && !canStartRun) {
      const state = getSessionRuntime?.()?.state || 'unknown';
      deps.showToast(state === 'suspended'
        ? '会话已挂起，请先处理待确认交互或停止当前任务'
        : '当前会话状态不允许发送消息', 'warning');
      return;
    }
    if ((!content && !draftAttachments.length) || (isLoading.value && !isRunningFollowup)) return;
    if (isRunningFollowup && draftAttachments.length) {
      deps.showToast('运行中补充暂不支持附件', 'warning');
      return;
    }

    const startsDraftSession = !currentSessionId.value;
    const requestId = createRequestId();
    let sessionId = currentSessionId.value;
    let attachments = draftAttachments;

    if (startsDraftSession) {
      lastFailedSendContent.value = content;
      deps.inputMessage.value = '';
      deps.clearComposerAttachments();
      beginPendingCommand('send', requestId);
    }

    try {
      sessionId = await deps.ensureSession({ replaceRoute: startsDraftSession });
    } catch (error) {
      console.error('Error creating session:', error);
      if (startsDraftSession) finishPendingCommand(requestId);
      deps.showToast('会话创建失败');
      return;
    }

    try {
      attachments = isRunningFollowup
        ? []
        : await deps.materializeAttachmentsForSend(draftAttachments, sessionId);
    } catch (error) {
      finishPendingCommand(requestId);
      deps.showToast(errorMessage(error) || '附件准备失败');
      return;
    }

    if (!startsDraftSession) beginPendingCommand(isRunningFollowup ? 'followup' : 'send', requestId);
    if (!startsDraftSession) {
      lastFailedSendContent.value = content;
      deps.inputMessage.value = '';
      deps.clearComposerAttachments();
    }

    try {
      /** @type {AnyRecord} */
      const body = {
        task: content,
        session_id: sessionId,
        attachments: attachments.map(serializeAttachmentForSend),
      };
      const selectedLlm = deps.getCurrentSelectedLlm();
      if (selectedLlm) body.selected_llm = selectedLlm;

      if (!sendViaSdk) throw new Error('Chat SDK 未初始化');
      const sdkResponse = await sendViaSdk({
        task: body.task,
        attachments: body.attachments,
        ...(body.selected_llm ? { selectedLlm: body.selected_llm } : {}),
      }, requestId);
      const result = sdkResponse?.data || sdkResponse || {};
      if (!result.started) {
        if (result.kind === 'command') {
          scheduleCommandFallback(sessionId);
          return;
        }
        throw new Error(result.error || '启动执行失败');
      }
      if (result.kind === 'command') scheduleCommandFallback(sessionId, 60000);
    } catch (error) {
      console.error('Error sending message:', error);
      finishPendingCommand(requestId);
      deps.showToast('消息发送失败', async () => {
        if (!lastFailedSendContent.value) return;
        deps.inputMessage.value = lastFailedSendContent.value;
        await nextTick();
        send();
      });
    }
  };

  /** @param {{ content?: string, attachments?: AnyRecord[] } | null} [payload] @returns {Promise<void>} */
  const send = (payload = null) => {
    const pending = sendQueue.then(() => sendNow(payload));
    sendQueue = pending.then(settleSendQueue, settleSendQueue);
    return pending;
  };

  return { send, stop };
}
