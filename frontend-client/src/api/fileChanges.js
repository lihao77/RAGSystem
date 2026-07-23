import { http } from './http.js';

export async function getLatestFileChanges(sessionId, messageSeq = null) {
  const query = new URLSearchParams();
  if (Number.isSafeInteger(messageSeq) && messageSeq > 0) query.set('message_seq', String(messageSeq));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return http.get(`/api/agent/sessions/${encodeURIComponent(sessionId)}/file-changes${suffix}`);
}
