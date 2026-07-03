import { ref } from 'vue';
import { defineStore } from 'pinia';

/**
 * 当前会话运行态单源。
 *
 * 收编原散落在两处的 7 个无行为纯状态字段：
 * - ChatViewV2 顶层 ref：messages / currentSessionId / isLoading / isCompressing
 * - useSessionTaskStatus 内部 ref：sessionTaskInfo / sessionExecutionObservability / contextUsage
 *
 * 各消费 composable 直接 useSessionRunStore() 取，不再走 deps 透传。业务行为（事件分发、
 * checkSessionTaskStatus 等）留 composable，本 store 只持有数据 + 纯重置。
 * activeRun(reactive)/llmRetryState(带定时器) 有行为，暂不入此 store，留阶段 2.3。
 */
export const useSessionRunStore = defineStore('session-run', () => {
  const currentSessionId = ref(null);
  const messages = ref([]);
  const isLoading = ref(false);
  const isCompressing = ref(false);
  const sessionTaskInfo = ref(null);
  const sessionExecutionObservability = ref(null);
  const contextUsage = ref({ used: 0, max: 0 });

  const resetContextUsage = () => {
    contextUsage.value = { used: 0, max: 0 };
  };

  return {
    currentSessionId,
    messages,
    isLoading,
    isCompressing,
    sessionTaskInfo,
    sessionExecutionObservability,
    contextUsage,
    resetContextUsage,
  };
});
