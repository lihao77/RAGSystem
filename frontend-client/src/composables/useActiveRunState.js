import { reactive } from 'vue';

export function createActiveRunState() {
  return {
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
  };
}

export function useActiveRunState() {
  return {
    activeRun: reactive(createActiveRunState()),
  };
}
