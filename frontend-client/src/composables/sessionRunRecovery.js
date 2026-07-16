// @ts-check
import { getSessionTaskStatus } from '../api/session.js';
import { resetActiveRunState } from '../stores/session-run.js';
import { shouldRefreshSessionMessagesAfterResume } from '../utils/sessionSocket.js';

/** @param {unknown} error */
const errorMessage = error => error instanceof Error ? error.message : String(error);

/** @param {any} options */
export function createSessionRunRecovery({
  getCurrentSessionId,
  activeRun,
  messages,
  isLoading,
  deleteMessageCache,
  loadSessionMessages,
  refreshSessionExecutionState,
  fetchTaskStatus = getSessionTaskStatus,
  scheduleTimer = setTimeout,
  cancelTimer = clearTimeout,
}) {
  /** @type {any} */
  let commandFallbackTimer = null;
  /** @type {any} */
  let resumeRecoveryTimer = null;
  /** @type {AbortController | null} */
  let resumeRecoveryAbort = null;

  const invalidateActiveStream = () => {
    resetActiveRunState(activeRun);
  };

  const clearCommandFallback = () => {
    if (!commandFallbackTimer) return;
    cancelTimer(commandFallbackTimer);
    commandFallbackTimer = null;
  };

  /** @param {string} sessionId @param {number} messageIndex @param {number} [timeout] */
  const scheduleCommandFallback = (sessionId, messageIndex, timeout = 10000) => {
    clearCommandFallback();
    commandFallbackTimer = scheduleTimer(() => {
      commandFallbackTimer = null;
      if (!isLoading.value) return;
      const message = messages.value[messageIndex];
      if (message && !message.finished) {
        message.content = message.content || '[命令执行超时或结果未送达]';
        message.metadata = { ...message.metadata, msg_type: 'command_result', success: false };
        message.finished = true;
      }
      invalidateActiveStream();
      isLoading.value = false;
      deleteMessageCache(sessionId);
      loadSessionMessages(sessionId, { silent: true });
    }, timeout);
  };

  const clearSessionResumeRecovery = () => {
    if (resumeRecoveryTimer) {
      cancelTimer(resumeRecoveryTimer);
      resumeRecoveryTimer = null;
    }
    if (resumeRecoveryAbort) {
      resumeRecoveryAbort.abort();
      resumeRecoveryAbort = null;
    }
  };

  /** @param {string} sessionId @param {number} [timeout] */
  const scheduleSessionResumeRecovery = (sessionId, timeout = 1500) => {
    clearSessionResumeRecovery();
    resumeRecoveryTimer = scheduleTimer(async () => {
      resumeRecoveryTimer = null;
      if (getCurrentSessionId() !== sessionId) return;
      if (activeRun.isReplaying || activeRun.lastSeenSeq > 0) return;
      const abort = new AbortController();
      resumeRecoveryAbort = abort;
      try {
        const result = await fetchTaskStatus(sessionId, { signal: abort.signal });
        if (getCurrentSessionId() !== sessionId || result.data?.has_running_task) return;
        if (shouldRefreshSessionMessagesAfterResume({
          hasRunningTask: false,
          activeRun: activeRun.active,
          messages: messages.value,
        })) {
          invalidateActiveStream();
          deleteMessageCache(sessionId);
          await loadSessionMessages(sessionId, { silent: true });
          return;
        }
        await refreshSessionExecutionState(sessionId, { silent: true });
      } catch (error) {
        console.warn('resume task-status 探测失败:', errorMessage(error));
      } finally {
        if (resumeRecoveryAbort === abort) resumeRecoveryAbort = null;
      }
    }, timeout);
  };

  return {
    invalidateActiveStream,
    scheduleCommandFallback,
    clearCommandFallback,
    scheduleSessionResumeRecovery,
    clearSessionResumeRecovery,
  };
}
