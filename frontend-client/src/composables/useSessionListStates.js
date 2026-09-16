import { onScopeDispose, ref, watch } from 'vue';
import { useSessionRunStore } from '../stores/session-run.js';

export const isSessionRunning = state => state === 'running' || state === 'resuming';

/** The list supplies initial states; one lightweight batch refresh covers inactive sessions. */
export function useSessionListStates(items, getClient) {
  const runStore = useSessionRunStore();
  const states = ref({});
  const revisions = new Map();
  let controller = null;
  let disposed = false;

  watch(() => runStore.sessionRuntime, runtime => {
    const id = runStore.currentSessionId;
    if (!id || !runtime) return;
    states.value[id] = runtime.state;
    revisions.set(id, (revisions.get(id) || 0) + 1);
  }, { immediate: true });

  const refresh = async () => {
    if (disposed || controller || document.visibilityState === 'hidden') return;
    const client = getClient();
    if (!client?.getSessionListStates) return;
    const ids = [...new Set(items.value.map(item => item.session_id))];
    const request = new AbortController();
    controller = request;
    try {
      for (let offset = 0; offset < ids.length; offset += 200) {
        const batch = ids.slice(offset, offset + 200);
        const before = new Map(revisions);
        const response = await client.getSessionListStates(batch, { signal: request.signal });
        if (request.signal.aborted) return;
        for (const item of response.data.items) {
          // A later WebSocket snapshot must win over an in-flight HTTP read.
          if (before.get(item.session_id) === revisions.get(item.session_id)) states.value[item.session_id] = item.state;
        }
      }
    } catch { /* Keep the last known states until the next successful refresh. */ }
    finally { controller = null; }
  };
  const interval = setInterval(refresh, 10_000);
  const onVisibilityChange = () => { void refresh(); };
  document.addEventListener('visibilitychange', onVisibilityChange);
  onScopeDispose(() => {
    disposed = true;
    clearInterval(interval);
    controller?.abort();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  return item => isSessionRunning(
    item.session_id === runStore.currentSessionId && runStore.sessionRuntime
      ? runStore.sessionRuntime.state
      : states.value[item.session_id] ?? item.runtime_state,
  );
}
