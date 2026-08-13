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

const getMessageRunId = message => message?.run_id || message?.metadata?.run_id || null;

const participantMessagesMatch = (current, incoming) => Boolean(
  (incoming?.id && current?.id === incoming.id)
  || (
    incoming?.role === 'assistant'
    && current?.role === 'assistant'
    && getMessageRunId(incoming)
    && getMessageRunId(current) === getMessageRunId(incoming)
  )
);

const mergeParticipantMessage = (current, incoming, { preserveLiveExecution = true } = {}) => {
  if (current === incoming) return current;
  const preservesExecution = preserveLiveExecution && current?.role === incoming?.role
    && (current?.role === 'assistant' || current?.role === 'user');
  const liveExecution = preservesExecution ? {
    _execState: current._execState,
    _executionRootCallId: current._executionRootCallId,
    executionTree: current.executionTree,
    executionStepsLoaded: current.executionStepsLoaded,
    executionStepsLoading: current.executionStepsLoading,
    executionStepsLoadError: current.executionStepsLoadError,
  } : null;
  Object.assign(current, incoming);
  for (const [key, value] of Object.entries(liveExecution || {})) {
    if (value !== undefined && value !== null) current[key] = value;
  }
  return current;
};

const sortParticipantMessages = (items) => {
  const canonical = items
    .filter(message => Number.isSafeInteger(message?.seq))
    .sort((left, right) => left.seq - right.seq);
  let canonicalIndex = 0;
  const next = items.map(message => (
    Number.isSafeInteger(message?.seq) ? canonical[canonicalIndex++] : message
  ));

  // A streaming assistant is the only non-canonical conversation item. It is
  // a carrier placeholder, so every persisted user boundary for that Run must
  // precede it even when the agent_message listener observed the input first.
  for (const assistant of next.filter(message => (
    message?.role === 'assistant'
      && !Number.isSafeInteger(message?.seq)
      && getMessageRunId(message)
  ))) {
    const runId = getMessageRunId(assistant);
    const assistantIndex = next.indexOf(assistant);
    const lastBoundaryIndex = next.findLastIndex(message => (
      message?.role === 'user'
        && Number.isSafeInteger(message?.seq)
        && getMessageRunId(message) === runId
    ));
    if (assistantIndex < 0 || lastBoundaryIndex < assistantIndex) continue;
    next.splice(assistantIndex, 1);
    const relocatedBoundaryIndex = next.findLastIndex(message => (
      message?.role === 'user'
        && Number.isSafeInteger(message?.seq)
        && getMessageRunId(message) === runId
    ));
    next.splice(relocatedBoundaryIndex + 1, 0, assistant);
  }
  return next;
};

/**
 * 当前会话运行态单源。
 *
 * 收编原散落在 ChatViewV2 顶层(messages/currentSessionId/isLoading/isCompressing)
 * 与 useActiveRunState 内部(activeRun reactive)的状态字段。
 * 会话上下文(team/workspace/entry_agent)也放这里，供对话页各区域同源消费；
 * 列表投影不含 Team snapshot，Team 身份以 Session detail 为准。
 * llmRetryState(带定时器) 有行为，留阶段 2.3b。
 *
 * 各消费 composable 直接 useSessionRunStore() 取，不再走 deps 透传。Session 生命周期只接受
 * 后端 session.runtime 快照；本 store 只持有数据、待确认请求和纯投影。
 */
export const useSessionRunStore = defineStore('session-run', () => {
  const currentSessionId = ref(null);
  const participantMessages = ref({ root: [] });
  const selectedParticipantId = ref('root');
  const messages = computed({
    get: () => participantMessages.value[selectedParticipantId.value] || [],
    set: (value) => {
      participantMessages.value = {
        ...participantMessages.value,
        [selectedParticipantId.value]: value,
      };
    },
  });
  const rootMessages = computed({
    get: () => participantMessages.value.root || [],
    set: (value) => {
      participantMessages.value = { ...participantMessages.value, root: value };
    },
  });
  const participants = ref([]);
  const participantsLoading = ref(false);
  const isCompressing = ref(false);
  const sessionRuntime = ref(null);
  // 只表示客户端请求尚未被服务端事实事件确认，不参与消息或 Run 投影。
  const pendingCommands = ref([]);
  // The source is intentionally kept with the value so the UI can distinguish
  // a snapshot/estimate from a provider measurement or a prediction.
  const contextUsage = ref({ used: 0, max: 0, source: 'none' });
  const activeRun = reactive(createActiveRunState());
  const llmRetryState = ref(null);
  // 会话上下文：已有 session 取 detail.metadata / workspace；新会话是创建前的 pending 选择
  const currentSessionTeam = ref('');
  const pendingWorkspaceRoot = ref('');
  const pendingEntryAgent = ref('');
  const sessionWorkspaceDisplay = ref('');

  const isLoading = computed(() => pendingCommands.value.length > 0
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
    contextUsage.value = { used: 0, max: 0, source: 'none' };
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
      resetActiveRunState(activeRun);
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
    const activeRequestId = snapshot?.active_run?.request_id;
    if (activeRequestId) finishPendingCommand(activeRequestId);
  };

  const clearSessionRuntime = () => {
    sessionRuntime.value = null;
    pendingCommands.value = [];
    activeRun.active = false;
    resetActiveRunState(activeRun);
  };

  const beginPendingCommand = (kind = 'send', requestId = null) => {
    if (requestId && pendingCommands.value.some(item => item.request_id === requestId)) return;
    pendingCommands.value.push({ kind, request_id: requestId, started_at: new Date().toISOString() });
  };

  const finishPendingCommand = (requestId = null) => {
    if (requestId) {
      pendingCommands.value = pendingCommands.value.filter(item => item.request_id !== requestId);
      return;
    }
    pendingCommands.value = [];
  };

  const allowsRuntimeAction = action => Boolean(sessionRuntime.value?.allowed_actions?.includes(action));

  const clearSessionContext = () => {
    currentSessionTeam.value = '';
    pendingWorkspaceRoot.value = '';
    pendingEntryAgent.value = '';
    sessionWorkspaceDisplay.value = '';
  };

  const resetSessionParticipants = () => {
    participantMessages.value = { root: [] };
    selectedParticipantId.value = 'root';
    participants.value = [];
    participantsLoading.value = false;
  };

  const setParticipants = (items) => {
    participants.value = Array.isArray(items) ? items : [];
    if (!participants.value.some(item => item?.participant_id === selectedParticipantId.value)) {
      selectedParticipantId.value = 'root';
    }
  };

  const setSelectedParticipant = (participantId) => {
    const next = typeof participantId === 'string' && participantId.trim()
      ? participantId.trim()
      : 'root';
    if (next === selectedParticipantId.value) return false;
    selectedParticipantId.value = next;
    return true;
  };

  const setParticipantMessages = (participantId, value) => {
    const id = typeof participantId === 'string' && participantId.trim() ? participantId.trim() : 'root';
    const next = Array.isArray(value) ? value : [];
    participantMessages.value = {
      ...participantMessages.value,
      [id]: next,
    };
    return next;
  };

  const reconcileParticipantMessages = (participantId, value, { preserveLiveExecution = true } = {}) => {
    const id = typeof participantId === 'string' && participantId.trim() ? participantId.trim() : 'root';
    const current = participantMessages.value[id] || [];
    const claimed = new Set();
    const durable = (Array.isArray(value) ? value : []).map((incoming) => {
      const index = current.findIndex((message, currentIndex) => (
        !claimed.has(currentIndex) && participantMessagesMatch(message, incoming)
      ));
      if (index < 0) return incoming;
      claimed.add(index);
      return mergeParticipantMessage(current[index], incoming, { preserveLiveExecution });
    });
    const live = current.filter((message, index) => !claimed.has(index) && !Number.isSafeInteger(message?.seq));
    const next = sortParticipantMessages([...durable, ...live]);
    const activeAssistant = id === 'root' && activeRun.assistantMsgIndex >= 0
      ? current[activeRun.assistantMsgIndex]
      : null;
    participantMessages.value = { ...participantMessages.value, [id]: next };
    if (activeAssistant) activeRun.assistantMsgIndex = next.indexOf(activeAssistant);
    return next;
  };

  const upsertParticipantMessage = (participantId, message) => {
    if (!message) return;
    const id = typeof participantId === 'string' && participantId.trim() ? participantId.trim() : 'root';
    const current = participantMessages.value[id] || [];
    const index = current.findIndex(item => participantMessagesMatch(item, message));
    const next = [...current];
    const activeAssistant = id === 'root' && activeRun.assistantMsgIndex >= 0
      ? current[activeRun.assistantMsgIndex]
      : null;
    if (index >= 0) next[index] = mergeParticipantMessage(next[index], message);
    else if (message.role === 'user' && message.metadata?.agent_message === true && getMessageRunId(message)) {
      const carrierIndex = next.findIndex(item => (
        item.role === 'assistant' && getMessageRunId(item) === getMessageRunId(message)
      ));
      next.splice(carrierIndex >= 0 ? carrierIndex : next.length, 0, message);
    } else next.push(message);
    const sorted = sortParticipantMessages(next);
    participantMessages.value = { ...participantMessages.value, [id]: sorted };
    if (activeAssistant) activeRun.assistantMsgIndex = sorted.indexOf(activeAssistant);
  };

  const reorderParticipantMessages = (participantId = 'root') => {
    const id = typeof participantId === 'string' && participantId.trim() ? participantId.trim() : 'root';
    const current = participantMessages.value[id] || [];
    const activeAssistant = id === 'root' && activeRun.assistantMsgIndex >= 0
      ? current[activeRun.assistantMsgIndex]
      : null;
    const sorted = sortParticipantMessages(current);
    participantMessages.value = { ...participantMessages.value, [id]: sorted };
    if (activeAssistant) activeRun.assistantMsgIndex = sorted.indexOf(activeAssistant);
    return sorted;
  };

  const clearParticipantMessages = (participantId = null) => {
    if (participantId) {
      const next = { ...participantMessages.value };
      delete next[participantId];
      if (participantId === 'root') next.root = [];
      participantMessages.value = next;
      return;
    }
    participantMessages.value = { root: [] };
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
    rootMessages,
    participantMessages,
    selectedParticipantId,
    participants,
    participantsLoading,
    isLoading,
    isCompressing,
    sessionRuntime,
    runtimeObservability,
    pendingCommands,
    contextUsage,
    activeRun,
    llmRetryState,
    currentSessionTeam,
    pendingWorkspaceRoot,
    pendingEntryAgent,
    sessionWorkspaceDisplay,
    resetContextUsage,
    resetActiveRun,
    applySessionRuntime,
    clearSessionRuntime,
    beginPendingCommand,
    finishPendingCommand,
    allowsRuntimeAction,
    clearSessionContext,
    applySessionContext,
    resetSessionParticipants,
    setParticipants,
    setSelectedParticipant,
    setParticipantMessages,
    reconcileParticipantMessages,
    upsertParticipantMessage,
    reorderParticipantMessages,
    clearParticipantMessages,
  };
});
