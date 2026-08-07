import { reactive } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';

const FINALIZED_RUN_WINDOW_MS = 10_000;
const DURABLE_REPLAY_RUN_EVENT_TYPES = new Set([
  'run_started',
  'run_ended',
  'agent_started',
  'agent_ended',
  'model_request',
  'model_attempt_started',
  'model_attempt_failed',
  'model_attempt_completed',
  'stream_output',
  'tool_call',
  'tool_result',
  'state_sync',
  'interaction',
  'error',
  'abort',
]);

/**
 * run 运行态机：phase/timing/waiting/seq gap/durable outbox replay/finalize。
 *
 * useSessionAgentClient 的运行态组合子（client 单向组合，无循环依赖）：只推进
 * activeRun/messages 等运行态，不参与事件分发（分发调度归 client.handleEnvelope）。
 * 状态读 session-run store 单源；业务回调（落库/刷新/滚动等）由 client 经 deps 注入。
 */
export function useRunRuntime(deps) {
  const sessionRunStore = useSessionRunStore();
  const {
    messages,
    isCompressing,
  } = storeToRefs(sessionRunStore);
  const activeRun = sessionRunStore.activeRun;

  // 私有运行态集中容器（非响应式用途，reactive 仅作统一封装）
  const internal = reactive({
    pendingReconciliation: false,
    durableReplay: { active: false, runId: null },
    lastFinalizedRun: { sessionId: null, runId: null, at: 0 },
  });
  // 去重标记：避免 markRecentSessionUpdated 对同一内容重复调用 updateRecentSession。
  // WeakMap 不进 reactive，避免污染消息对象（不会被 cacheMessages 序列化）
  const recentSessionUpdatedFor = new WeakMap();

  const eventTimestampSeconds = (event) => {
    const ts = Number(event?.timestamp);
    return Number.isFinite(ts) && ts > 0 ? ts : Date.now() / 1000;
  };

  const computeLatencyMs = (startSeconds, endSeconds) => {
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return null;
    return Math.max(0, Math.round((endSeconds - startSeconds) * 1000));
  };

  const extractRunId = (source) => {
    if (!source || typeof source !== 'object') return null;
    return source.run_id || source.payload?.run_id || source.metadata?.run_id || null;
  };

  const terminalStatusFromEvent = (event) => {
    const status = event?.payload?.status;
    return ['completed', 'failed', 'interrupted', 'suspended'].includes(status) ? status : 'completed';
  };

  const messageRunId = (msg) => msg?.run_id || msg?.metadata?.run_id || null;

  const findAssistantMessageIndexByRunId = (runId, predicate = () => true) => {
    if (!runId) return -1;
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
      const msg = messages.value[index];
      if (msg?.role === 'assistant' && messageRunId(msg) === runId && predicate(msg)) {
        return index;
      }
    }
    return -1;
  };

  const hasFinishedAssistantForRun = (runId) => (
    findAssistantMessageIndexByRunId(runId, msg => msg.finished === true) >= 0
  );

  const phaseIsRuntimeLocked = () => activeRun.phase === 'approval_waiting' || activeRun.phase === 'suspended';

  const resetActiveRunRuntime = () => {
    Object.assign(activeRun, {
      phase: 'idle',
      rootCallId: null,
      runningToolCalls: {},
      runningModelCalls: {},
      runStartedAt: null,
      firstTokenAt: null,
      firstTokenLatencyMs: null,
      latestLlmFirstTokenAt: null,
      lastChunkAt: null,
      outputCharCount: 0,
    });
  };

  const startActiveRunRuntime = (event) => {
    const phase = phaseIsRuntimeLocked() ? activeRun.phase : 'processing';
    Object.assign(activeRun, {
      phase,
      rootCallId: null,
      runningToolCalls: {},
      runningModelCalls: {},
      runStartedAt: eventTimestampSeconds(event),
      firstTokenAt: null,
      firstTokenLatencyMs: null,
      latestLlmFirstTokenAt: null,
      lastChunkAt: null,
      outputCharCount: 0,
    });
  };

  const markRootAgentStarted = (event) => {
    if (event?.call_id) activeRun.rootCallId = event.call_id;
  };

  const modelCallKey = event => `${event?.agent_id || ''}\u0000${event?.call_id || ''}`;

  const refreshActivityPhase = () => {
    if (phaseIsRuntimeLocked()) return;
    const toolCount = Object.keys(activeRun.runningToolCalls || {}).length;
    const models = Object.values(activeRun.runningModelCalls || {});
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
  };

  const updateModelCall = (event, status) => {
    if (!event?.call_id) return;
    const key = modelCallKey(event);
    const retryDelayMs = Number(event?.payload?.retry_delay_ms);
    const retryAt = status === 'retry_wait'
      ? new Date(
          eventTimestampSeconds(event) * 1000
          + (Number.isFinite(retryDelayMs) ? Math.max(0, retryDelayMs) : 0),
        ).toISOString()
      : null;
    activeRun.runningModelCalls = {
      ...(activeRun.runningModelCalls || {}),
      [key]: {
        ...(activeRun.runningModelCalls?.[key] || {}),
        ...(event.payload || {}),
        call_id: event.call_id,
        agent_id: event.agent_id || '',
        status,
        retry_at: retryAt,
      },
    };
    refreshActivityPhase();
  };

  const markModelRequestStarted = (event, isRoot = false) => {
    if (isRoot && event?.call_id) activeRun.rootCallId = event.call_id;
    updateModelCall(event, 'requested');
  };

  const markModelAttemptStarted = event => updateModelCall(event, 'waiting');

  const markModelAttemptFailed = event => updateModelCall(
    event,
    event?.payload?.will_retry ? 'retry_wait' : 'failed',
  );

  const markModelStreaming = event => updateModelCall(event, 'streaming');

  const markModelAttemptCompleted = (event) => {
    const next = { ...(activeRun.runningModelCalls || {}) };
    delete next[modelCallKey(event)];
    activeRun.runningModelCalls = next;
    refreshActivityPhase();
  };

  const markLlmFirstToken = (event, eventData) => {
    const ts = eventTimestampSeconds(event);
    if (!activeRun.firstTokenAt) {
      const elapsedMs = Number(eventData.elapsed_ms);
      activeRun.firstTokenAt = ts;
      activeRun.firstTokenLatencyMs = Number.isFinite(elapsedMs)
        ? Math.max(0, Math.round(elapsedMs))
        : computeLatencyMs(activeRun.runStartedAt, ts);
    }
    activeRun.latestLlmFirstTokenAt = ts;
    updateModelCall(event, 'streaming');
  };

  const markOutputChunk = (event, content) => {
    const ts = eventTimestampSeconds(event);
    updateModelCall(event, 'streaming');
    activeRun.lastChunkAt = ts;
    activeRun.outputCharCount = (activeRun.outputCharCount || 0) + (content?.length || 0);
    if (!activeRun.firstTokenAt) {
      activeRun.firstTokenAt = ts;
      activeRun.firstTokenLatencyMs = computeLatencyMs(activeRun.runStartedAt, ts);
    }
  };

  const markToolStarted = (event, eventData) => {
    const callId = event?.call_id;
    if (!callId) return;
    const invocationCallId = eventData?.lineage?.parent_call_id || '';
    const models = Object.fromEntries(Object.entries(activeRun.runningModelCalls || {}).filter(
      ([, model]) => !invocationCallId || model.call_id !== invocationCallId,
    ));
    activeRun.runningModelCalls = models;
    activeRun.runningToolCalls = {
      ...(activeRun.runningToolCalls || {}),
      [callId]: {
        tool: typeof eventData?.tool === 'string' ? eventData.tool : '',
        agent_id: event.agent_id || '',
        parent_call_id: invocationCallId,
      },
    };
    refreshActivityPhase();
  };

  const markToolFinished = (event) => {
    const next = { ...(activeRun.runningToolCalls || {}) };
    const callId = event?.call_id;
    if (!callId || !Object.prototype.hasOwnProperty.call(next, callId)) return;
    delete next[callId];
    activeRun.runningToolCalls = next;
    refreshActivityPhase();
  };

  const markAgentFinished = (event) => {
    const invocationCallId = event?.call_id;
    if (!invocationCallId) return;
    activeRun.runningModelCalls = Object.fromEntries(Object.entries(activeRun.runningModelCalls || {}).filter(
      ([, model]) => model.call_id !== invocationCallId,
    ));
    activeRun.runningToolCalls = Object.fromEntries(Object.entries(activeRun.runningToolCalls || {}).filter(
      ([, tool]) => tool.parent_call_id !== invocationCallId,
    ));
    refreshActivityPhase();
  };

  const observeDeliverySeq = (event) => {
    const deliverySeq = Number(event?.seq ?? 0);
    if (!Number.isFinite(deliverySeq) || deliverySeq <= 0) return;
    if (activeRun.lastSeenSeq > 0 && deliverySeq > activeRun.lastSeenSeq + 1) {
      internal.pendingReconciliation = true;
    }
    activeRun.lastSeenSeq = deliverySeq;
  };

  const resetPendingReconciliation = () => {
    internal.pendingReconciliation = false;
  };

  const reconcileAfterGap = (sessionId, currentMsg) => {
    internal.pendingReconciliation = false;
    const hasRenderableFinalMessage = Boolean(
      currentMsg
      && currentMsg.role === 'assistant'
      && currentMsg.finished
      && (currentMsg.content || '').trim()
    );
    if (hasRenderableFinalMessage && typeof deps.mergeMessageIdsFromServer === 'function') {
      // fire-and-forget：此时 run 已结束，无后续代码依赖合并结果
      deps.mergeMessageIdsFromServer(sessionId);
      return;
    }
    deps.deleteMessageCache(sessionId);
    deps.loadSessionMessages(sessionId, { silent: true });
  };

  const markRecentSessionUpdated = (sessionId, msg) => {
    if (!msg?.content) return;
    if (recentSessionUpdatedFor.get(msg) === msg.content) return;
    deps.updateRecentSession(sessionId, msg.content, new Date().toISOString());
    recentSessionUpdatedFor.set(msg, msg.content);
  };

  const isDurableOutboxReplayEnvelope = (event) => event?.payload?.replay_source === 'durable_outbox';

  const isActiveRunSnapshotReplayEnvelope = (event) => (
    event?.payload?.replay_source === 'active_run_snapshot'
  );

  /** active run 快照是可重建投影；断线重放前清空旧的半截内容，避免 delta 重复追加。 */
  const resetActiveRunPresentation = (runId) => {
    const currentMsg = messages.value[activeRun.assistantMsgIndex];
    if (!currentMsg || (runId && messageRunId(currentMsg) && messageRunId(currentMsg) !== runId)) return;
    currentMsg.content = '';
    currentMsg.executionTree = { root: null, steps: [] };
    currentMsg._execState = null;
    currentMsg.has_execution = false;
    currentMsg.finished = false;
    currentMsg.status = [];
    activeRun.runningToolCalls = {};
    activeRun.runningModelCalls = {};
    activeRun.rootCallId = null;
  };

  const setDurableReplay = (state) => {
    internal.durableReplay = { active: !!state?.active, runId: state?.runId || null };
  };

  const isDurableReplayActive = () => internal.durableReplay.active;

  const getDurableReplayRunId = (event) => extractRunId(event) || internal.durableReplay.runId || null;

  const ensureDurableReplayActiveRun = (event) => {
    const runId = getDurableReplayRunId(event);
    if (hasFinishedAssistantForRun(runId)) return false;

    let assistantMsgIndex = findAssistantMessageIndexByRunId(runId, msg => msg.finished !== true);
    if (assistantMsgIndex < 0) {
      const lastMsg = messages.value[messages.value.length - 1];
      if (lastMsg?.role === 'assistant' && !lastMsg.finished && (!runId || !messageRunId(lastMsg))) {
        assistantMsgIndex = messages.value.length - 1;
        if (runId) {
          lastMsg.run_id = runId;
          lastMsg.metadata = { ...(lastMsg.metadata || {}), run_id: runId };
        }
      }
    }
    if (assistantMsgIndex < 0) {
      messages.value.push(deps.createAssistantMessage(runId ? { run_id: runId, metadata: { run_id: runId } } : undefined));
      assistantMsgIndex = messages.value.length - 1;
    }

    activeRun.assistantMsgIndex = assistantMsgIndex;
    activeRun.active = true;
    activeRun.runId = runId;
    activeRun.lastSeenSeq = 0;
    if (!activeRun.phase || activeRun.phase === 'idle') {
      activeRun.phase = 'processing';
      activeRun.runStartedAt = eventTimestampSeconds(event);
    }
    return true;
  };

  const refreshMessagesAfterInactiveDurableTerminal = (sessionId) => {
    deps.deleteMessageCache(sessionId);
    deps.loadSessionMessages(sessionId, { silent: true });
  };

  const handleInactiveDurableReplayEvent = (event, sessionId) => {
    if (!internal.durableReplay.active || activeRun.active) return false;

    const eventType = event.type;
    const runId = getDurableReplayRunId(event);
    if (runId && hasFinishedAssistantForRun(runId)) {
      return true;
    }

    if (eventType === 'run_ended') {
      refreshMessagesAfterInactiveDurableTerminal(sessionId);
      return true;
    }

    if (!DURABLE_REPLAY_RUN_EVENT_TYPES.has(eventType)) return false;
    return !ensureDurableReplayActiveRun(event);
  };

  const rememberFinalizedRun = (sessionId, currentMsg) => {
    internal.lastFinalizedRun = {
      sessionId,
      runId: activeRun.runId || extractRunId(currentMsg) || null,
      at: Date.now(),
    };
  };

  const isRecentlyFinalizedUpdate = (event, sessionId) => {
    const updateRunId = extractRunId(event);
    if (!updateRunId || !internal.lastFinalizedRun.runId) return false;
    return (
      internal.lastFinalizedRun.sessionId === sessionId
      && internal.lastFinalizedRun.runId === updateRunId
      && Date.now() - internal.lastFinalizedRun.at < FINALIZED_RUN_WINDOW_MS
    );
  };

  const finalizeActiveRun = (sessionId) => {
    let finalizedMsg = null;
    if (activeRun.active) {
      const currentMsg = messages.value[activeRun.assistantMsgIndex];
      finalizedMsg = currentMsg || null;
      if (currentMsg && !currentMsg.finished) {
        currentMsg.finished = true;
        markRecentSessionUpdated(sessionId, currentMsg);
      }
      deps.cacheMessages(sessionId, messages.value);
      rememberFinalizedRun(sessionId, currentMsg);
      resetActiveRunRuntime();
      activeRun.active = false;
    }
    if (internal.pendingReconciliation) {
      reconcileAfterGap(sessionId, finalizedMsg);
    }
    deps.clearLlmRetryState();
    isCompressing.value = false;
    deps.scrollToBottom();
  };

  const resetInternal = () => {
    internal.pendingReconciliation = false;
    internal.durableReplay = { active: false, runId: null };
    internal.lastFinalizedRun = { sessionId: null, runId: null, at: 0 };
  };

  return {
    // 计时
    startActiveRunRuntime,
    resetActiveRunRuntime,
    markRootAgentStarted,
    markModelRequestStarted,
    markModelAttemptStarted,
    markModelAttemptFailed,
    markModelAttemptCompleted,
    markModelStreaming,
    markLlmFirstToken,
    markOutputChunk,
    markToolStarted,
    markToolFinished,
    markAgentFinished,
    // seq gap
    observeDeliverySeq,
    resetPendingReconciliation,
    // 元数据更新（finalize 与流式收尾共用）
    markRecentSessionUpdated,
    // durable replay
    isDurableOutboxReplayEnvelope,
    isActiveRunSnapshotReplayEnvelope,
    resetActiveRunPresentation,
    setDurableReplay,
    isDurableReplayActive,
    handleInactiveDurableReplayEvent,
    // finalized 窗口
    isRecentlyFinalizedUpdate,
    // finalize
    finalizeActiveRun,
    // 工具
    terminalStatusFromEvent,
    eventTimestampSeconds,
    // reset
    resetInternal,
  };
}
