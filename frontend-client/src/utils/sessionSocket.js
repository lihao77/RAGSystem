import {
  getEnvelopeCursorSeq,
  getEnvelopeEventSeq,
  normalizeEnvelopeSeq,
} from '@ragsystem/agent-protocol/wire';

const WS_OPEN = 1;
const WS_CONNECTING = 0;

export function normalizeEventSeq(value) {
  return normalizeEnvelopeSeq(value);
}

export function getDurableEventSeq(event) {
  if (!event || typeof event !== 'object') return null;
  return getEnvelopeEventSeq(event);
}

export function getDurableCursorSeq(event) {
  if (!event || typeof event !== 'object') return null;
  return getEnvelopeCursorSeq(event);
}

export function buildSessionSocketUrl(sessionId, options = {}) {
  const protocol = options.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = options.host || '';
  const encodedSessionId = encodeURIComponent(sessionId);
  const params = new URLSearchParams();
  const hasAfterEventSeq = options.afterEventSeq !== null && options.afterEventSeq !== undefined;
  const rawAfterEventSeq = Number(options.afterEventSeq);
  const afterEventSeq = hasAfterEventSeq && Number.isSafeInteger(rawAfterEventSeq) && rawAfterEventSeq >= 0
    ? rawAfterEventSeq
    : null;
  if (afterEventSeq !== null) params.set('after_seq', String(afterEventSeq));
  if (typeof options.ticket === 'string' && options.ticket) {
    params.set('ticket', options.ticket);
  }
  const query = params.toString();
  return `${protocol}//${host}/api/agent/sessions/${encodedSessionId}/ws${query ? `?${query}` : ''}`;
}

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
