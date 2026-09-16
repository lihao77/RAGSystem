import { computed, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth.js';
import { MAX_PINNED_SESSIONS, normalizePinnedSessionIds } from '../stores/session-list-hydration.js';

/** Pins are local user preferences; session content is always refreshed from the list API. */
export function useSessionPins(items, getClient) {
  const auth = useAuthStore();
  const ids = ref([]);
  const cache = ref({});
  const revisions = new Map();
  const markUpdated = id => revisions.set(id, (revisions.get(id) || 0) + 1);
  let controller = null;
  const storageKey = computed(() => `ragsystem:pinned-sessions:${encodeURIComponent(auth.tenantId || 'local')}:${encodeURIComponent(auth.user?.id || 'local')}`);

  const persist = () => {
    ids.value = normalizePinnedSessionIds(ids.value);
    try { localStorage.setItem(storageKey.value, JSON.stringify(ids.value)); } catch { /* Storage may be unavailable. */ }
  };
  const sync = (entries) => {
    const next = { ...cache.value };
    for (const item of entries) {
      if (!ids.value.includes(item.session_id)) continue;
      next[item.session_id] = item;
      markUpdated(item.session_id);
    }
    cache.value = next;
  };
  const unpin = (sessionId) => {
    if (!ids.value.includes(sessionId)) return;
    ids.value = ids.value.filter(id => id !== sessionId);
    delete cache.value[sessionId];
    markUpdated(sessionId);
    persist();
  };
  const toggle = (item) => {
    if (ids.value.includes(item.session_id)) unpin(item.session_id);
    else {
      if (ids.value.length >= MAX_PINNED_SESSIONS) return false;
      ids.value = [item.session_id, ...ids.value];
      sync([item]);
      persist();
    }
    return true;
  };
  const load = async () => {
    controller?.abort();
    if (!ids.value.length || !getClient()) return;
    const request = new AbortController();
    controller = request;
    const requestedIds = [...ids.value];
    for (let offset = 0; offset < requestedIds.length;) {
      const batch = [];
      // Leave room for the path and headers, including for long Unicode IDs.
      while (offset < requestedIds.length && batch.length < MAX_PINNED_SESSIONS) {
        const candidate = [...batch, requestedIds[offset]];
        const query = new URLSearchParams({ session_ids: JSON.stringify(candidate), limit: String(MAX_PINNED_SESSIONS) });
        if (batch.length && query.toString().length > 6000) break;
        batch.push(requestedIds[offset++]);
      }
      const before = new Map(revisions);
      const response = await getClient().listSessions({ sessionIds: batch, limit: MAX_PINNED_SESSIONS, signal: request.signal });
      if (request.signal.aborted) return;
      // Cache updates after the request began take precedence over its snapshot.
      const unchanged = id => before.get(id) === revisions.get(id);
      sync(response.data.items.filter(item => unchanged(item.session_id)));
      const found = new Set(response.data.items.map(item => item.session_id));
      for (const id of batch) if (!found.has(id) && unchanged(id)) unpin(id);
    }
  };
  watch(storageKey, () => {
    controller?.abort();
    cache.value = {};
    revisions.clear();
    try { ids.value = normalizePinnedSessionIds(JSON.parse(localStorage.getItem(storageKey.value) || '[]')); }
    catch { ids.value = []; }
    persist();
    void load().catch(() => undefined);
  }, { immediate: true });
  watch(items, entries => sync(entries), { deep: true, flush: 'sync' });

  return {
    ids,
    items: computed(() => ids.value.map(id => cache.value[id]).filter(Boolean)),
    toggle, unpin, sync, load,
    getById: id => cache.value[id] || null,
    dispose: () => controller?.abort(),
  };
}
