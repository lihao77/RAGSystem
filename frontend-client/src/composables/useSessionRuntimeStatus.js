import { storeToRefs } from 'pinia';
import { getContextSnapshot } from '../api/session.js';
import { useSessionRunStore } from '../stores/session-run.js';

/** Session runtime lifecycle is delivered by WebSocket; this composable owns only reset and context loading. */
export function useSessionRuntimeStatus({ clearLlmRetryState, chatSdkClient }) {
  const store = useSessionRunStore();
  const { currentSessionId, contextUsage } = storeToRefs(store);

  const loadContextSnapshot = async (sessionId) => {
    if (!sessionId) return;
    try {
      const json = await (chatSdkClient?.getContextSnapshot
        ? chatSdkClient.getContextSnapshot(sessionId)
        : getContextSnapshot(sessionId));
      if (currentSessionId.value !== sessionId) return;
      const tokenStats = json.data?.token_stats;
      if (tokenStats && typeof tokenStats.total_tokens === 'number'
        && typeof tokenStats.budget_tokens === 'number') {
        contextUsage.value = { used: tokenStats.total_tokens, max: tokenStats.budget_tokens };
      }
    } catch (error) {
      console.warn('loadContextSnapshot 失败:', error instanceof Error ? error.message : String(error));
    }
  };

  const clearExecutionState = ({ resetContextUsage = false } = {}) => {
    clearLlmRetryState();
    store.clearSessionRuntime();
    if (resetContextUsage) contextUsage.value = { used: 0, max: 0 };
  };

  return { loadContextSnapshot, clearExecutionState };
}
