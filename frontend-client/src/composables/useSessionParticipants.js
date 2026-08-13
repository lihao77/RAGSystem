import { computed, onScopeDispose } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';

const PARTICIPANT_EVENTS = new Set(['agent_started', 'agent_ended']);

export function useSessionParticipants({ chatSdkClient, showToast }) {
  const store = useSessionRunStore();
  const {
    currentSessionId,
    participants,
    participantsLoading,
    selectedParticipantId,
  } = storeToRefs(store);
  let loadSeq = 0;
  const participantByRun = new Map();

  const selectedParticipant = computed(() => participants.value.find(
    item => item?.participant_id === selectedParticipantId.value,
  ) || participants.value.find(item => item?.participant_id === 'root') || null);

  const loadSessionParticipants = async (sessionId = currentSessionId.value, { silent = false } = {}) => {
    if (!sessionId) {
      store.setParticipants([]);
      return [];
    }
    const seq = ++loadSeq;
    if (!silent) participantsLoading.value = true;
    try {
      const result = await chatSdkClient.listSessionParticipants(sessionId);
      if (seq !== loadSeq || currentSessionId.value !== sessionId) return [];
      const items = Array.isArray(result?.data?.items) ? result.data.items : [];
      store.setParticipants(items);
      return items;
    } catch (error) {
      if (seq === loadSeq && currentSessionId.value === sessionId && !silent) {
        showToast(error?.message || '加载智能体列表失败');
      }
      return [];
    } finally {
      if (seq === loadSeq) participantsLoading.value = false;
    }
  };

  const projectParticipantLifecycle = (event) => {
    const sessionId = event?.session_id || chatSdkClient.sessionId || currentSessionId.value;
    if (!sessionId || sessionId !== currentSessionId.value) return;
    const payload = event?.payload || {};
    const runId = event?.run_id || null;
    const childAgentId = payload.child_agent_id
      || (runId ? participantByRun.get(runId) : null)
      || (runId ? participants.value.find(item => (
        item?.scope === 'child' && item?.last_run_id === runId
      ))?.participant_id : null);
    const participantId = childAgentId || 'root';
    if (runId && childAgentId) participantByRun.set(runId, childAgentId);
    const existing = participants.value.find(item => item?.participant_id === participantId);
    const status = event.type === 'agent_started'
      ? 'running'
      : payload.status === 'succeeded' ? 'completed' : payload.status || null;
    const projected = {
      ...(existing || {}),
      participant_id: participantId,
      parent_participant_id: existing?.parent_participant_id ?? (participantId === 'root' ? null : 'root'),
      scope: participantId === 'root' ? 'root' : 'child',
      agent_name: event.agent_id || existing?.agent_name || null,
      display_name: payload.display_name || existing?.display_name || event.agent_id || null,
      thread_key: existing?.thread_key || (participantId === 'root' ? 'root' : `child:${participantId}`),
      lifecycle_status: participantId === 'root' ? 'active' : (existing?.lifecycle_status || 'active'),
      last_run_id: runId || existing?.last_run_id || null,
      last_run_status: status,
      created_at: existing?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.setParticipants(existing
      ? participants.value.map(item => item === existing ? projected : item)
      : [...participants.value, projected]);
  };

  const unsubscribe = chatSdkClient.on?.('event', (event) => {
    if (!PARTICIPANT_EVENTS.has(event?.type)) return;
    projectParticipantLifecycle(event);
  });

  onScopeDispose(() => {
    unsubscribe?.();
    participantByRun.clear();
  });

  return {
    participants,
    participantsLoading,
    selectedParticipantId,
    selectedParticipant,
    loadSessionParticipants,
  };
}
