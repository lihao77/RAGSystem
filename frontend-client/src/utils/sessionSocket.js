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
  if (options.historySnapshot === true) params.set('history_snapshot', '1');
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
