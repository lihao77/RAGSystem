import { computed, ref, unref, watch } from 'vue';
import {
  getCurrentGoal,
  pauseCurrentGoal,
  startCurrentGoal,
} from '../api/goal.js';

function goalFromResponse(response) {
  return response?.goal ?? response?.data?.goal ?? null;
}

/**
 * Current Goal state and controls for a reactive session id.
 *
 * Request generations prevent a slow response from a previous session from
 * replacing the newly selected session's Goal.
 */
export function useSessionGoal(sessionId) {
  const goal = ref(null);
  const loading = ref(false);
  const pendingAction = ref(null);
  const error = ref('');
  let requestGeneration = 0;

  const currentSessionId = () => String(unref(sessionId) || '').trim();

  const canStart = computed(() => {
    return goal.value?.status === 'paused' || goal.value?.status === 'blocked';
  });

  const canPause = computed(() => goal.value?.status === 'active');

  async function loadGoal({ silent = false } = {}) {
    const selectedSessionId = currentSessionId();
    const generation = ++requestGeneration;
    if (!selectedSessionId) {
      goal.value = null;
      error.value = '';
      loading.value = false;
      return null;
    }

    if (!silent) loading.value = true;
    error.value = '';
    try {
      const response = await getCurrentGoal(selectedSessionId);
      if (generation !== requestGeneration || selectedSessionId !== currentSessionId()) return null;
      goal.value = goalFromResponse(response);
      return goal.value;
    } catch (cause) {
      if (generation !== requestGeneration || selectedSessionId !== currentSessionId()) return null;
      error.value = cause?.message || 'Goal 状态加载失败';
      return null;
    } finally {
      if (generation === requestGeneration && !silent) loading.value = false;
    }
  }

  async function runAction(action, request) {
    const selectedSessionId = currentSessionId();
    if (!selectedSessionId || pendingAction.value) return null;

    const generation = ++requestGeneration;
    pendingAction.value = action;
    error.value = '';
    try {
      const response = await request(selectedSessionId);
      if (generation !== requestGeneration || selectedSessionId !== currentSessionId()) return null;
      goal.value = goalFromResponse(response);
      return goal.value;
    } catch (cause) {
      if (generation !== requestGeneration || selectedSessionId !== currentSessionId()) return null;
      error.value = cause?.message || `Goal ${action === 'start' ? '开启' : '暂停'}失败`;
      return null;
    } finally {
      if (generation === requestGeneration) pendingAction.value = null;
    }
  }

  const startGoal = () => runAction('start', startCurrentGoal);
  const pauseGoal = () => runAction('pause', pauseCurrentGoal);

  watch(
    () => currentSessionId(),
    () => {
      goal.value = null;
      pendingAction.value = null;
      loadGoal();
    },
    { immediate: true },
  );

  return {
    goal,
    loading,
    pendingAction,
    error,
    canStart,
    canPause,
    loadGoal,
    startGoal,
    pauseGoal,
  };
}
