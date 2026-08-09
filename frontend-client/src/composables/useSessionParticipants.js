import { computed, onScopeDispose } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';

const PARTICIPANT_EVENTS = new Set(['agent_started', 'agent_ended', 'agent_message']);

export function useSessionParticipants({ chatSdkClient, showToast }) {
  const store = useSessionRunStore();
  const {
    currentSessionId,
    participants,
    participantsLoading,
    selectedParticipantId,
  } = storeToRefs(store);
  let loadSeq = 0;
  let refreshTimer = null;

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

  const scheduleRefresh = (sessionId) => {
    if (!sessionId || sessionId !== currentSessionId.value) return;
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void loadSessionParticipants(sessionId, { silent: true });
    }, 180);
  };

  const unsubscribe = chatSdkClient.on?.('event', (event) => {
    if (!PARTICIPANT_EVENTS.has(event?.type)) return;
    scheduleRefresh(event.session_id || chatSdkClient.sessionId || currentSessionId.value);
  });

  onScopeDispose(() => {
    unsubscribe?.();
    if (refreshTimer) window.clearTimeout(refreshTimer);
  });

  return {
    participants,
    participantsLoading,
    selectedParticipantId,
    selectedParticipant,
    loadSessionParticipants,
  };
}
