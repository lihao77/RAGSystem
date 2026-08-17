import { storeToRefs } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';

/** Session runtime lifecycle is delivered by WebSocket; this composable owns only reset and context loading. */
export function useSessionRuntimeStatus({ clearLlmRetryState, chatSdkClient }) {
  const store = useSessionRunStore();
  const { currentSessionId, contextUsage } = storeToRefs(store);

  const loadContextSnapshot = async (sessionId) => {
    if (!sessionId) return;
    try {
      if (!chatSdkClient) throw new Error('Chat SDK 未初始化');
      const json = await chatSdkClient.getContextSnapshot(sessionId);
      if (currentSessionId.value !== sessionId) return;
      const tokenStats = json.data?.token_stats;
      if (tokenStats && typeof tokenStats.total_tokens === 'number'
        && typeof tokenStats.budget_tokens === 'number') {
        const isProvider = tokenStats.token_source === 'provider';
        const systemPromptTokens = typeof tokenStats.system_prompt_tokens === 'number'
          ? tokenStats.system_prompt_tokens
          : null;
        const sessionCached = typeof tokenStats.session_cached_input_tokens === 'number'
          ? tokenStats.session_cached_input_tokens : 0;
        const sessionCreation = typeof tokenStats.session_cache_creation_input_tokens === 'number'
          ? tokenStats.session_cache_creation_input_tokens : 0;
        const sessionInput = typeof tokenStats.session_input_tokens === 'number'
          ? tokenStats.session_input_tokens : 0;
        contextUsage.value = {
          used: isProvider ? tokenStats.total_tokens : 0,
          max: isProvider ? tokenStats.budget_tokens : 0,
          source: isProvider ? 'provider' : 'unavailable',
          ...(isProvider ? { providerUsed: tokenStats.total_tokens } : {}),
          // 会话级缓存命中累计（全部 run 之和）；命中或写入 >0 才携带，命中率 >0 才显示。
          ...(isProvider && sessionInput > 0 && (sessionCached > 0 || sessionCreation > 0)
            ? {
                cachedInputTokens: sessionCached,
                ...(sessionCreation > 0 ? { cacheCreationInputTokens: sessionCreation } : {}),
                inputTokens: sessionInput,
              }
            : {}),
          // 快照口径构成占比：进入会话后 hover 不依赖实时事件也能展示消息/系统提示词。
          ...(isProvider && systemPromptTokens !== null
            ? {
                systemPromptTokens,
                historyTokens: Math.max(0, tokenStats.total_tokens - systemPromptTokens),
              }
            : {}),
        };
      }
    } catch (error) {
      console.warn('loadContextSnapshot 失败:', error instanceof Error ? error.message : String(error));
    }
  };

  const clearExecutionState = ({ resetContextUsage = false } = {}) => {
    clearLlmRetryState();
    store.clearSessionRuntime();
    if (resetContextUsage) contextUsage.value = { used: 0, max: 0, source: 'none' };
  };

  return { loadContextSnapshot, clearExecutionState };
}
