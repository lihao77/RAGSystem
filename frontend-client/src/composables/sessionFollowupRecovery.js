/** Reconcile pending sends against durable receipts, including sends made before this view mounted. */
export function createSessionFollowupRecovery({ sdk, store, loadMessages, showToast, intervalMs = 2000 }) {
  let timer = null;
  let disposed = false;
  let pending = null;
  const stop = () => { clearTimeout(timer); timer = null; };
  const schedule = () => {
    stop();
    if (disposed || !sdk.listMessageRequestStatuses || !store.currentSessionId) return;
    timer = setTimeout(() => { void refresh(); }, intervalMs);
    timer.unref?.();
  };
  const refresh = async () => {
    stop();
    const sessionId = store.currentSessionId;
    if (disposed || !sessionId || !sdk.listMessageRequestStatuses) return;
    if (pending) {
      schedule();
      return pending;
    }
    let retry = false;
    pending = (async () => {
      const requestIds = store.pendingFollowups.filter(item => item.session_id === sessionId).map(item => item.request_id);
      const chunks = requestIds.length ? Array.from({ length: Math.ceil(requestIds.length / 100) }, (_, index) => requestIds.slice(index * 100, (index + 1) * 100)) : [[]];
      const statuses = new Map();
      for (const chunk of chunks) {
        const response = await sdk.listMessageRequestStatuses(sessionId, chunk);
        for (const item of response?.data?.items || []) statuses.set(item.request_id, item);
      }
      if (disposed || store.currentSessionId !== sessionId) return;
      let consumed = false;
      for (const item of statuses.values()) {
        if (item.status === 'processing' || item.status === 'queued' || item.status === 'consumed') {
          store.markFollowupAccepted(sessionId, item.request_id);
        }
        const existing = store.pendingFollowups.find(entry => entry.session_id === sessionId && entry.request_id === item.request_id);
        // A consumption event may have removed a send while the older HTTP snapshot was in flight.
        if (requestIds.includes(item.request_id) && !existing) continue;
        if (item.status === 'consumed') {
          consumed ||= Boolean(existing);
          continue;
        }
        if (item.status === 'failed') {
          store.removePendingFollowup(sessionId, item.request_id);
          if (existing) showToast(item.error || '补充消息发送失败', 'warning');
        } else if (item.status === 'processing' || item.status === 'queued') {
          store.queueFollowup(sessionId, item.request_id, item.content);
          const queued = store.pendingFollowups.find(entry => entry.session_id === sessionId && entry.request_id === item.request_id);
          if (queued) queued.status = item.status;
        }
      }
      if (consumed) {
        const watermark = await loadMessages(sessionId, { participantId: 'root', silent: true, preserveStream: true, bypassCache: true });
        // A consumed row may be older than the visible history page; only settle it after a successful reload.
        if (Number.isSafeInteger(watermark) && !disposed && store.currentSessionId === sessionId) {
          for (const item of statuses.values()) {
            if (item.status === 'consumed') store.removePendingFollowup(sessionId, item.request_id);
          }
        }
      }
    })().catch(() => {
      // A failed query does not prove that a send failed. Keep content for the next reconciliation.
      retry = true;
    }).finally(() => {
      pending = null;
      if (!disposed && (retry || store.currentSessionId !== sessionId || store.currentPendingFollowups.length)) schedule();
    });
    return pending;
  };
  return { refresh, schedule, stop, dispose() { disposed = true; stop(); } };
}
