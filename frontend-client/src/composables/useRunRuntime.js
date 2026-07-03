import { reactive } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';

const FINALIZED_RUN_WINDOW_MS = 10_000;
const DURABLE_REPLAY_RUN_EVENT_TYPES = new Set([
  'run_started',
  'run_ended',
  'agent_started',
  'agent_ended',
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
 * 从 useSessionRunStream 抽出的内聚单元，只推进 activeRun/messages 等运行态，
 * 不参与事件分发（分发调度仍归 useSessionRunStream）。
 * 状态读 session-run store 单源；业务回调（落库/刷新/滚动等）由 deps 注入。
 */
export function useRunRuntime(deps) {
  const sessionRunStore = useSessionRunStore();
  const {
    messages,
    isLoading,
    isCompressing,
    sessionTaskInfo,
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
    return ['completed', 'failed', 'interrupted'].includes(status) ? status : 'completed';
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

  const resetActiveRunRuntime = () => {
    Object.assign(activeRun, {
      phase: 'idle',
      runStartedAt: null,
      firstTokenAt: null,
      firstTokenLatencyMs: null,
      latestLlmFirstTokenAt: null,
      lastChunkAt: null,
      waiting: null,
      outputCharCount: 0,
    });
  };

  const startActiveRunRuntime = (event) => {
    Object.assign(activeRun, {
      phase: 'llm_waiting_first_token',
      runStartedAt: eventTimestampSeconds(event),
      firstTokenAt: null,
      firstTokenLatencyMs: null,
      latestLlmFirstTokenAt: null,
      lastChunkAt: null,
      waiting: null,
      outputCharCount: 0,
    });
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
    activeRun.phase = 'llm_streaming';
    activeRun.waiting = null;
  };

  const markOutputChunk = (event, content) => {
    const ts = eventTimestampSeconds(event);
    activeRun.phase = 'llm_streaming';
    activeRun.lastChunkAt = ts;
    activeRun.outputCharCount = (activeRun.outputCharCount || 0) + (content?.length || 0);
    if (!activeRun.firstTokenAt) {
      activeRun.firstTokenAt = ts;
      activeRun.firstTokenLatencyMs = computeLatencyMs(activeRun.runStartedAt, ts);
    }
  };

  const markWaitingStart = (event, eventData) => {
    activeRun.phase = 'background_waiting';
    activeRun.waiting = {
      waitId: eventData.wait_id || '',
      backgroundTaskIds: Array.isArray(eventData.background_task_ids) ? eventData.background_task_ids : [],
      pendingTaskIds: Array.isArray(eventData.pending_task_ids) ? eventData.pending_task_ids : [],
      pendingTaskCount: Number.isFinite(eventData.pending_task_count) ? eventData.pending_task_count : 0,
      timeoutMs: Number.isFinite(eventData.timeout_ms) ? eventData.timeout_ms : null,
      startedAt: eventTimestampSeconds(event),
    };
  };

  const markWaitingFinished = (eventData) => {
    const currentWaitId = activeRun.waiting?.waitId;
    const finishedWaitId = eventData?.wait_id || '';
    if (currentWaitId && finishedWaitId && currentWaitId !== finishedWaitId) return;
    activeRun.waiting = null;
    if (activeRun.active) activeRun.phase = 'llm_waiting_first_token';
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

  const setDurableReplay = (state) => {
    internal.durableReplay = { active: !!state?.active, runId: state?.runId || null };
  };

  const isDurableReplayActive = () => internal.durableReplay.active;

  const getDurableReplayRunId = (event) => extractRunId(event) || internal.durableReplay.runId || null;

  const ensureDurableReplayActiveRun = (event, sessionId) => {
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

    activeRun.active = true;
    activeRun.assistantMsgIndex = assistantMsgIndex;
    activeRun.runId = runId;
    activeRun.lastSeenSeq = 0;
    if (!activeRun.phase || activeRun.phase === 'idle') {
      activeRun.phase = 'llm_waiting_first_token';
      activeRun.runStartedAt = eventTimestampSeconds(event);
    }
    isLoading.value = true;
    if (runId) {
      sessionTaskInfo.value = {
        ...(sessionTaskInfo.value || {}),
        run_id: runId,
        session_id: sessionId,
        status: 'running',
      };
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
      if (eventType === 'run_ended') {
        sessionTaskInfo.value = {
          ...(sessionTaskInfo.value || {}),
          run_id: runId,
          session_id: sessionId,
          thread_alive: false,
          status: terminalStatusFromEvent(event),
        };
        deps.refreshSessionExecutionState(sessionId, { silent: true });
      }
      return true;
    }

    if (eventType === 'run_ended') {
      sessionTaskInfo.value = {
        ...(sessionTaskInfo.value || {}),
        ...(runId ? { run_id: runId } : {}),
        session_id: sessionId,
        thread_alive: false,
        status: terminalStatusFromEvent(event),
      };
      refreshMessagesAfterInactiveDurableTerminal(sessionId);
      deps.refreshSessionExecutionState(sessionId, { silent: true });
      return true;
    }

    if (!DURABLE_REPLAY_RUN_EVENT_TYPES.has(eventType)) return false;
    return !ensureDurableReplayActiveRun(event, sessionId);
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
        deps.checkSituationScreenTrigger(currentMsg.content);
      }
      deps.cacheMessages(sessionId, messages.value);
      rememberFinalizedRun(sessionId, currentMsg);
      activeRun.active = false;
      resetActiveRunRuntime();
    }
    if (internal.pendingReconciliation) {
      reconcileAfterGap(sessionId, finalizedMsg);
    }
    deps.clearLlmRetryState();
    isCompressing.value = false;
    isLoading.value = false;
    deps.refreshSessionExecutionState(sessionId, { silent: true });
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
    markLlmFirstToken,
    markOutputChunk,
    markWaitingStart,
    markWaitingFinished,
    // seq gap
    observeDeliverySeq,
    resetPendingReconciliation,
    // 元数据更新（finalize 与流式收尾共用）
    markRecentSessionUpdated,
    // durable replay
    isDurableOutboxReplayEnvelope,
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
