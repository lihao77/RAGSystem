// @ts-check
import { resetActiveRunState } from '../stores/session-run.js';

/** @param {import('./sessionCoreTypes.js').SessionRunRecoveryOptions} options */
export function createSessionRunRecovery({
  activeRun,
  isLoading,
  deleteMessageCache,
  loadSessionMessages,
  finishPendingCommand,
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

  /** @param {string} sessionId @param {number} [timeout] */
  const scheduleCommandFallback = (sessionId, timeout = 10000) => {
    clearCommandFallback();
    commandFallbackTimer = scheduleTimer(() => {
      commandFallbackTimer = null;
      if (!isLoading.value) return;
      invalidateActiveStream();
      finishPendingCommand();
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
