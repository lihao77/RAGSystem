import { reactive, ref } from 'vue';
import { defineStore } from 'pinia';

export const createActiveRunState = () => ({
  active: false,
  assistantMsgIndex: -1,
  runId: null,
  lastSeenSeq: 0,
  isReplaying: false,
  phase: 'idle',
  runStartedAt: null,
  firstTokenAt: null,
  firstTokenLatencyMs: null,
  latestLlmFirstTokenAt: null,
  lastChunkAt: null,
  waiting: null,
  outputCharCount: 0,
});

export const resetActiveRunState = (activeRun) => {
  if (!activeRun) return;
  Object.assign(activeRun, createActiveRunState());
};

/**
 * 当前会话运行态单源。
 *
 * 收编原散落在 ChatViewV2 顶层(messages/currentSessionId/isLoading/isCompressing)、
 * useSessionTaskStatus 内部(sessionTaskInfo/sessionExecutionObservability/contextUsage)、
 * useActiveRunState 内部(activeRun reactive)的状态字段。
 * llmRetryState(带定时器) 有行为，留阶段 2.3b。
 *
 * 各消费 composable 直接 useSessionRunStore() 取，不再走 deps 透传。业务行为（事件分发、
 * checkSessionTaskStatus 等）留 composable，本 store 只持有数据 + 纯重置。
 */
export const useSessionRunStore = defineStore('session-run', () => {
  const currentSessionId = ref(null);
  const messages = ref([]);
  const isLoading = ref(false);
  const isCompressing = ref(false);
  const sessionTaskInfo = ref(null);
  const sessionExecutionObservability = ref(null);
  const contextUsage = ref({ used: 0, max: 0 });
  const activeRun = reactive(createActiveRunState());

  const resetContextUsage = () => {
    contextUsage.value = { used: 0, max: 0 };
  };

  const resetActiveRun = () => resetActiveRunState(activeRun);

  return {
    currentSessionId,
    messages,
    isLoading,
    isCompressing,
    sessionTaskInfo,
    sessionExecutionObservability,
    contextUsage,
    activeRun,
    resetContextUsage,
    resetActiveRun,
  };
});
