const WS_OPEN = 1;
const WS_CONNECTING = 0;

export function canReuseSessionSocket(targetSessionId, currentSessionId, ws) {
  if (!targetSessionId || !currentSessionId || targetSessionId !== currentSessionId || !ws) {
    return false;
  }
  return ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING;
}

/**
 * 判断恢复会话时是否需要刷新消息。
 * 仅在前端存在不一致状态时返回 true：
 * - activeRun 但后端无运行任务 → 前端状态陈旧
 * - 有未完成的 assistant 消息 → 流式中断
 *
 * 注意：不再检查"最后一条是 user"。后端 has_running_task=false 是终态，
 * 即使最后一条消息是 user 也说明会话处于空闲等待输入状态，不需要刷新。
 */
export function shouldRefreshSessionMessagesAfterResume({ hasRunningTask, activeRun, messages }) {
  if (hasRunningTask) return false;
  if (activeRun) return true;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  return messages.some((msg) => msg?.role === 'assistant' && msg?.finished === false);
}

export function shouldRunResumeRecoveryWatchdog({ hasRunningTask, hasActiveSystemCommand }) {
  return Boolean(hasRunningTask && !hasActiveSystemCommand);
}
