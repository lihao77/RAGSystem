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
  const llmRetryState = ref(null);
  // 正在等待服务端 message_saved 确认的运行中补充消息。它们不属于主消息列表。
  const pendingFollowupCandidates = ref([]);

  const resetContextUsage = () => {
    contextUsage.value = { used: 0, max: 0 };
  };

  const resetActiveRun = () => resetActiveRunState(activeRun);

  const enqueueFollowupCandidate = (candidate) => {
    const requestId = candidate?.metadata?.request_id;
    if (requestId && pendingFollowupCandidates.value.some(
      item => item?.metadata?.request_id === requestId,
    )) return;
    pendingFollowupCandidates.value.push(candidate);
  };

  const takeFollowupCandidate = (requestId) => {
    const index = pendingFollowupCandidates.value.findIndex(
      item => item?.metadata?.request_id === requestId,
    );
    if (index < 0) return null;
    return pendingFollowupCandidates.value.splice(index, 1)[0] || null;
  };

  const markFollowupCandidateFailed = (requestId, error) => {
    const candidate = pendingFollowupCandidates.value.find(
      item => item?.metadata?.request_id === requestId,
    );
    if (!candidate) return;
    candidate.metadata = { ...candidate.metadata, persistence_status: 'failed' };
    candidate.status = [
      ...(candidate.status || []),
      { type: 'error', content: error || '补充说明发送失败' },
    ];
  };

  const bindUnassignedFollowupCandidates = (runId) => {
    if (!runId) return;
    for (const candidate of pendingFollowupCandidates.value) {
      if (!candidate?.metadata?.run_id) {
        candidate.metadata = { ...candidate.metadata, run_id: runId };
      }
    }
  };

  const clearFollowupCandidates = () => {
    pendingFollowupCandidates.value = [];
  };

  return {
    currentSessionId,
    messages,
    isLoading,
    isCompressing,
    sessionTaskInfo,
    sessionExecutionObservability,
    contextUsage,
    activeRun,
    llmRetryState,
    pendingFollowupCandidates,
    resetContextUsage,
    resetActiveRun,
    enqueueFollowupCandidate,
    takeFollowupCandidate,
    markFollowupCandidateFailed,
    bindUnassignedFollowupCandidates,
    clearFollowupCandidates,
  };
});
