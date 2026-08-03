// @ts-check
import { nextTick, ref } from 'vue';

import { createAssistantMessage } from './useMessageExecution.js';
import { createAttachmentsExtension } from '../utils/messageExtensions.js';

/** @typedef {Record<string, any>} AnyRecord */
/** @param {unknown} error */
const errorMessage = error => error instanceof Error ? error.message : String(error);

/** @param {AnyRecord} activeRun @param {number} assistantMsgIndex */
export const resetActiveRunForSend = (activeRun, assistantMsgIndex) => {
  Object.assign(activeRun, {
    assistantMsgIndex,
    runId: null,
    rootCallId: null,
    lastSeenSeq: 0,
    isReplaying: false,
    phase: 'starting_agent',
    runningToolCalls: {},
    runningModelCalls: {},
    runStartedAt: Date.now() / 1000,
    firstTokenAt: null,
    firstTokenLatencyMs: null,
    latestLlmFirstTokenAt: null,
    lastChunkAt: null,
    outputCharCount: 0,
  });
};

/** @param {AnyRecord} activeRun */
const resetActiveRunAfterSendError = (activeRun) => {
  Object.assign(activeRun, {
    phase: 'idle',
    rootCallId: null,
    runningToolCalls: {},
    runningModelCalls: {},
    runStartedAt: null,
    firstTokenAt: null,
    firstTokenLatencyMs: null,
    latestLlmFirstTokenAt: null,
    lastChunkAt: null,
    outputCharCount: 0,
  });
};

/** @param {AnyRecord} attachment */
export const serializeAttachmentForSend = ({ file_id }) => ({ file_id });

const createRequestId = () => globalThis.crypto?.randomUUID?.()
  || `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** @param {AnyRecord[]} attachments @param {AnyRecord} [metadata] */
const buildUserMetadata = (attachments, metadata = {}) => {
  const result = { ...metadata };
  const existingExtensions = Array.isArray(result.extensions)
    ? result.extensions.filter(extension => extension?.kind !== 'attachments')
    : [];
  const attachmentExtension = createAttachmentsExtension(attachments);
  const extensions = attachmentExtension ? [...existingExtensions, attachmentExtension] : existingExtensions;
  if (extensions.length) result.extensions = extensions;
  else delete result.extensions;
  return result;
};

/** @param {string} content @param {AnyRecord[]} attachments @param {AnyRecord} [metadata] */
export const createUserMessage = (content, attachments, metadata = {}) => ({
  role: 'user',
  content,
  attachments,
  metadata: buildUserMetadata(attachments, metadata),
});

/** @param {string} requestId */
const createAgentStreamMetadata = requestId => ({
  request_id: requestId,
  execution_kind: 'agent_stream',
});

/** @param {string} requestId @param {AnyRecord} activeRun @param {string | null} [fallbackRunId] */
const createFollowupMetadata = (requestId, activeRun, fallbackRunId = null) => ({
  request_id: requestId,
  execution_kind: 'session_followup',
  source: 'running_session',
  persistence_status: 'pending',
  ...(activeRun.runId || fallbackRunId ? { run_id: activeRun.runId || fallbackRunId } : {}),
});

/** @param {import('./sessionCoreTypes.js').SessionCommandControllerOptions} options */
export function createSessionCommandController({
  deps,
  currentSessionId,
  messages,
  isLoading,
  contextUsage,
  activeRun,
  allowsRuntimeAction,
  getSessionRuntime,
  beginOptimisticCommand,
  finishOptimisticCommand,
  scheduleCommandFallback,
  enqueueFollowupCandidate,
  markFollowupCandidateFailed,
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
    const runtimeRunId = getSessionRuntime?.()?.active_run?.run_id || null;
    let userMetadata = isRunningFollowup
      ? createFollowupMetadata(requestId, activeRun, runtimeRunId)
      : createAgentStreamMetadata(requestId);
    let sessionId = currentSessionId.value;
    let assistantMsgIndex = -1;
    let userMsgIndex = -1;
    let attachments = draftAttachments;

    if (startsDraftSession) {
      userMsgIndex = messages.value.push(createUserMessage(content, draftAttachments, userMetadata)) - 1;
      deps.inputMessage.value = '';
      deps.clearComposerAttachments();
      deps.stickToBottom();
      assistantMsgIndex = messages.value.push(createAssistantMessage()) - 1;
      resetActiveRunForSend(activeRun, assistantMsgIndex);
      activeRun.phase = 'creating_session';
      beginOptimisticCommand('send');
      contextUsage.value = { used: 0, max: 0 };
    }

    try {
      sessionId = await deps.ensureSession({ replaceRoute: startsDraftSession });
    } catch (error) {
      console.error('Error creating session:', error);
      if (startsDraftSession) {
        const currentMessage = messages.value[assistantMsgIndex];
        if (currentMessage) {
          currentMessage.content += `\n\n[System Error: ${errorMessage(error) || '创建会话失败'}]`;
          currentMessage.finished = true;
        }
        resetActiveRunAfterSendError(activeRun);
        finishOptimisticCommand();
      }
      deps.showToast('会话创建失败');
      return;
    }

    if (startsDraftSession && activeRun.active) {
      activeRun.phase = draftAttachments.length ? 'preparing_attachments' : 'starting_agent';
    }

    try {
      attachments = isRunningFollowup
        ? []
        : await deps.materializeAttachmentsForSend(draftAttachments, sessionId);
    } catch (error) {
      if (startsDraftSession) {
        const currentMessage = messages.value[assistantMsgIndex];
        if (currentMessage) {
          currentMessage.content += `\n\n[System Error: ${errorMessage(error) || '附件准备失败'}]`;
          currentMessage.finished = true;
        }
        resetActiveRunAfterSendError(activeRun);
        finishOptimisticCommand();
      }
      deps.showToast(errorMessage(error) || '附件准备失败');
      return;
    }

    if (startsDraftSession && activeRun.active) activeRun.phase = 'starting_agent';

    if (startsDraftSession) {
      const userMessage = messages.value[userMsgIndex];
      if (userMessage) {
        userMessage.attachments = attachments;
        userMessage.metadata = buildUserMetadata(attachments, userMetadata);
      }
      deps.cacheMessages(sessionId, messages.value);
    } else if (isRunningFollowup) {
      const rounds = messages.value[activeRun.assistantMsgIndex]?.executionTree?.root?.rounds;
      const roundIndex = Array.isArray(rounds) && rounds.length ? rounds.at(-1).round : null;
      enqueueFollowupCandidate(createUserMessage(content, [], {
        ...userMetadata,
        ...(roundIndex != null ? { round_index: roundIndex } : {}),
      }));
      deps.inputMessage.value = '';
      deps.clearComposerAttachments();
    } else {
      messages.value.push(createUserMessage(content, attachments, userMetadata));
      deps.inputMessage.value = '';
      deps.clearComposerAttachments();
      deps.stickToBottom();
    }
    // 运行中补充先留在候选区，等服务端落库确认后再更新会话摘要。
    if (!isRunningFollowup) deps.updateRecentSession(sessionId, content, new Date().toISOString());

    if (!startsDraftSession && !isRunningFollowup) {
      assistantMsgIndex = messages.value.push(createAssistantMessage()) - 1;
      resetActiveRunForSend(activeRun, assistantMsgIndex);
    }
    if (!isRunningFollowup && !startsDraftSession) beginOptimisticCommand('send');
    if (!startsDraftSession && !isRunningFollowup) {
      contextUsage.value = { used: 0, max: 0 };
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
          scheduleCommandFallback(sessionId, assistantMsgIndex);
          return;
        }
        throw new Error(result.error || '启动执行失败');
      }
      if (result.run_id || result.runId) activeRun.runId = result.run_id || result.runId;
      if (result.kind === 'command') scheduleCommandFallback(sessionId, assistantMsgIndex, 60000);
    } catch (error) {
      console.error('Error sending message:', error);
      if (isRunningFollowup) {
        markFollowupCandidateFailed(requestId, errorMessage(error));
      } else {
        const currentMessage = messages.value[assistantMsgIndex];
        if (currentMessage) {
          currentMessage.content += `\n\n[System Error: ${errorMessage(error) || 'Request failed'}]`;
          currentMessage.finished = true;
        }
        resetActiveRunAfterSendError(activeRun);
        finishOptimisticCommand();
      }
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
