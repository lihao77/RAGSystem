import { getSessionTaskStatus } from '../api/session.js';
import { resetActiveRunState } from '../stores/session-run.js';
import { shouldRefreshSessionMessagesAfterResume } from '../utils/sessionSocket.js';

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
  let commandFallbackTimer = null;
  let resumeRecoveryTimer = null;
  let resumeRecoveryAbort = null;

  const invalidateActiveStream = () => {
    resetActiveRunState(activeRun);
  };

  const clearCommandFallback = () => {
    if (!commandFallbackTimer) return;
    cancelTimer(commandFallbackTimer);
    commandFallbackTimer = null;
  };

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
        console.warn('resume task-status 探测失败:', error.message);
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
