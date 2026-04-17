const WS_OPEN = 1;
const WS_CONNECTING = 0;

export function canReuseSessionSocket(targetSessionId, currentSessionId, ws) {
  if (!targetSessionId || !currentSessionId || targetSessionId !== currentSessionId || !ws) {
    return false;
  }
  return ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING;
}

export function shouldRefreshSessionMessagesAfterResume({ hasRunningTask, activeRun, messages }) {
  if (hasRunningTask) return false;
  if (activeRun) return true;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  if (messages.some((msg) => msg?.role === 'assistant' && msg?.finished === false)) {
    return true;
  }
  const lastConversationMessage = [...messages]
    .reverse()
    .find((msg) => msg?.role === 'assistant' || (msg?.role === 'user' && msg?.metadata?.source !== 'system.bg_notification'));
  return lastConversationMessage?.role === 'user';
}

export function shouldRunResumeRecoveryWatchdog({ hasRunningTask, hasActiveSystemCommand }) {
  return Boolean(hasRunningTask && !hasActiveSystemCommand);
}
