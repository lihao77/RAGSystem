// @ts-check
import { resetActiveRunState } from '../stores/session-run.js';

/** @param {import('./sessionCoreTypes.js').SessionRunRecoveryOptions} options */
export function createSessionRunRecovery({
  activeRun,
  messages,
  isLoading,
  deleteMessageCache,
  loadSessionMessages,
  finishOptimisticCommand,
  scheduleTimer = setTimeout,
  cancelTimer = clearTimeout,
}) {
  /** @type {any} */
  let commandFallbackTimer = null;
  /** @type {any} */

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
        message.content_parts = [{
          type: 'command_result',
          invocation_id: 'pending-command',
          name: 'unknown',
          success: false,
          text: message.content,
          error: 'timeout',
        }];
        message.finished = true;
      }
      invalidateActiveStream();
      finishOptimisticCommand();
      deleteMessageCache(sessionId);
      loadSessionMessages(sessionId, { silent: true });
    }, timeout);
  };

  return {
    invalidateActiveStream,
    scheduleCommandFallback,
    clearCommandFallback,
  };
}
