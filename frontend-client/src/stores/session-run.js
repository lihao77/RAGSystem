import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';

export const createActiveRunState = () => ({
  active: false,
  assistantMsgIndex: -1,
  runId: null,
  rootCallId: null,
  lastSeenSeq: 0,
  isReplaying: false,
  phase: 'idle',
  runningToolCalls: {},
  runningModelCalls: {},
  runStartedAt: null,
  firstTokenAt: null,
  firstTokenLatencyMs: null,
  latestLlmFirstTokenAt: null,
  lastChunkAt: null,
  outputCharCount: 0,
});

export const resetActiveRunState = (activeRun) => {
  if (!activeRun) return;
  const active = Boolean(activeRun.active);
  Object.assign(activeRun, createActiveRunState());
  activeRun.active = active;
};

const parseRuntimeTimestampSeconds = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = value.trim();
  const sqliteUtcTimestamp = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
  const normalized = sqliteUtcTimestamp.test(timestamp)
    ? `${timestamp.replace(' ', 'T')}Z`
    : timestamp;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : null;
};

/**
 * 当前会话运行态单源。
 *
 * 收编原散落在 ChatViewV2 顶层(messages/currentSessionId/isLoading/isCompressing)
 * 与 useActiveRunState 内部(activeRun reactive)的状态字段。
 * 会话上下文(team/workspace/entry_agent)也放这里，供对话页各区域同源消费；
 * 列表投影不含 metadata.team，team 以 session detail 为准。
 * llmRetryState(带定时器) 有行为，留阶段 2.3b。
 *
 * 各消费 composable 直接 useSessionRunStore() 取，不再走 deps 透传。Session 生命周期只接受
 * 后端 session.runtime 快照；本 store 只持有数据、乐观命令和纯投影。
 */
export const useSessionRunStore = defineStore('session-run', () => {
  const currentSessionId = ref(null);
  const messages = ref([]);
  const isCompressing = ref(false);
  const sessionRuntime = ref(null);
  const optimisticCommand = ref(null);
  const contextUsage = ref({ used: 0, max: 0 });
  const activeRun = reactive(createActiveRunState());
  const llmRetryState = ref(null);
  // 正在等待服务端 message_saved 确认的运行中补充消息。它们不属于主消息列表。
  const pendingFollowupCandidates = ref([]);
  // 会话上下文：已有 session 取 detail.metadata / workspace；新会话是创建前的 pending 选择
  const currentSessionTeam = ref('');
  const pendingWorkspaceRoot = ref('');
  const pendingEntryAgent = ref('');
  const sessionWorkspaceDisplay = ref('');

  const isLoading = computed(() => Boolean(optimisticCommand.value)
    || Boolean(sessionRuntime.value && sessionRuntime.value.state !== 'idle'));
  const runtimeObservability = computed(() => {
    const run = sessionRuntime.value?.active_run || sessionRuntime.value?.last_run;
    if (!run) return null;
    return {
      session_id: currentSessionId.value,
      run_id: run.run_id,
      execution_kind: sessionRuntime.value?.active_run?.execution_kind || null,
      request_id: sessionRuntime.value?.active_run?.request_id || null,
    };
  });

  const resetContextUsage = () => {
    contextUsage.value = { used: 0, max: 0 };
  };

  const resetActiveRun = () => resetActiveRunState(activeRun);

  const applySessionRuntime = (snapshot) => {
    const previousRunId = activeRun.runId;
    sessionRuntime.value = snapshot;
    const hasActiveRun = Boolean(snapshot?.active_run);
    const nextRunId = snapshot?.active_run?.run_id || null;
    const activity = snapshot?.active_run?.activity || { models: [], tools: [] };
    activeRun.runningToolCalls = Object.fromEntries(
      (activity.tools || []).map(tool => [tool.call_id, tool]),
    );
    activeRun.runningModelCalls = Object.fromEntries(
      (activity.models || []).map(model => [`${model.agent_id || ''}\u0000${model.call_id}`, model]),
    );
    if (previousRunId !== nextRunId) activeRun.rootCallId = null;
    activeRun.active = hasActiveRun;
    activeRun.runId = nextRunId;
    activeRun.runStartedAt = hasActiveRun && snapshot.active_run.started_at
      ? parseRuntimeTimestampSeconds(snapshot.active_run.started_at)
      : null;
    if (!hasActiveRun) {
      // An idle snapshot is authoritative once a run was already attached.
      // Only keep the active presentation while a send/rollback is still
      // waiting for its first durable runtime snapshot.
      const active = Boolean(optimisticCommand.value);
      resetActiveRunState(activeRun);
      activeRun.active = active;
    } else if (snapshot.state === 'waiting_interaction') {
      activeRun.phase = 'approval_waiting';
    } else if (snapshot.state === 'suspended') {
      activeRun.phase = snapshot.pending_interactions?.length > 0
        ? 'approval_waiting'
        : 'suspended';
    } else if (snapshot.state === 'resuming') {
      activeRun.phase = 'starting_agent';
    } else if (snapshot.state === 'running') {
      const toolCount = Object.keys(activeRun.runningToolCalls).length;
      const models = Object.values(activeRun.runningModelCalls);
      activeRun.phase = toolCount > 0 && models.length > 0
        ? 'parallel_running'
        : toolCount > 0
          ? 'tool_running'
          : models.some(model => model.status === 'retry_wait')
            ? 'retrying'
            : models.some(model => model.status === 'streaming')
              ? 'model_streaming'
              : models.some(model => model.status === 'failed')
                ? 'model_failed'
                : models.length > 0 ? 'model_waiting' : 'processing';
    }
    if (snapshot?.state !== 'idle') optimisticCommand.value = null;
  };

  const clearSessionRuntime = () => {
    sessionRuntime.value = null;
    optimisticCommand.value = null;
    activeRun.active = false;
    resetActiveRunState(activeRun);
  };

  const beginOptimisticCommand = (kind = 'send') => {
    optimisticCommand.value = { kind, started_at: new Date().toISOString() };
    if (kind === 'send') activeRun.active = true;
  };

  const finishOptimisticCommand = () => {
    optimisticCommand.value = null;
    activeRun.active = Boolean(sessionRuntime.value?.active_run);
  };

  const allowsRuntimeAction = action => Boolean(sessionRuntime.value?.allowed_actions?.includes(action));

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

  const clearSessionContext = () => {
    currentSessionTeam.value = '';
    pendingWorkspaceRoot.value = '';
    pendingEntryAgent.value = '';
    sessionWorkspaceDisplay.value = '';
  };

  const applySessionContext = ({
    team = '',
    entryAgent = '',
    workspaceRoot = '',
    workspaceDisplay = '',
  } = {}) => {
    currentSessionTeam.value = typeof team === 'string' ? team : '';
    pendingEntryAgent.value = typeof entryAgent === 'string' ? entryAgent : '';
    pendingWorkspaceRoot.value = typeof workspaceRoot === 'string' ? workspaceRoot : '';
    sessionWorkspaceDisplay.value = typeof workspaceDisplay === 'string' ? workspaceDisplay : '';
  };

  return {
    currentSessionId,
    messages,
    isLoading,
    isCompressing,
    sessionRuntime,
    runtimeObservability,
    optimisticCommand,
    contextUsage,
    activeRun,
    llmRetryState,
    pendingFollowupCandidates,
    currentSessionTeam,
    pendingWorkspaceRoot,
    pendingEntryAgent,
    sessionWorkspaceDisplay,
    resetContextUsage,
    resetActiveRun,
    applySessionRuntime,
    clearSessionRuntime,
    beginOptimisticCommand,
    finishOptimisticCommand,
    allowsRuntimeAction,
    enqueueFollowupCandidate,
    takeFollowupCandidate,
    markFollowupCandidateFailed,
    bindUnassignedFollowupCandidates,
    clearFollowupCandidates,
    clearSessionContext,
    applySessionContext,
  };
});
