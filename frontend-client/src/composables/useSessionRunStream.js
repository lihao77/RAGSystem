import { nextTick } from 'vue';

function normalizeSessionRunStreamDeps(deps) {
  const {
    state = {},
    messageStore = {},
    sessionStatus = {},
    connection = {},
    retry = {},
    execution = {},
    approvals = {},
    notifications = {},
    artifacts = {},
    ui = {},
    sending = {},
  } = deps || {};

  return {
    ...deps,
    ...state,
    ...messageStore,
    ...sessionStatus,
    ...connection,
    ...retry,
    ...execution,
    ...approvals,
    ...notifications,
    ...artifacts,
    ...ui,
    ...sending,
  };
}

/**
 * 会话流式事件路由与 run 生命周期管理。
 *
 * 只负责消费 WS 事件、推进 activeRun/message 状态，
 * 不负责 socket 连接建立本身，也不改动视图模板结构。
 */
export function useSessionRunStream(deps) {
  const startupPhases = new Set(['creating_session', 'preparing_attachments', 'starting_agent']);

  deps = normalizeSessionRunStreamDeps(deps);

  // seq gap 标记：run 期间发生过事件丢失，run 结束后做一次轻量对账
  let _pendingReconciliation = false;
  const FINALIZED_RUN_WINDOW_MS = 10_000;
  let _lastFinalizedRun = {
    sessionId: null,
    runId: null,
    at: 0,
  };
  // 去重标记：避免 markRecentSessionUpdated 对同一内容重复调用 updateRecentSession
  // 用 WeakMap 避免污染消息对象（不会被 cacheMessages 序列化）
  const _recentSessionUpdatedFor = new WeakMap();
  const USER_INPUT_ACK_TIMEOUT_MS = 8000;
  const USER_INPUT_ACK_TIMEOUT_CODE = 'USER_INPUT_ACK_TIMEOUT';
  const USER_INPUT_REJECTED_CODE = 'USER_INPUT_REJECTED';
  const DURABLE_REPLAY_RUN_EVENT_TYPES = new Set([
    'agent.error',
    'agent.end',
    'agent.intent_complete',
    'agent.intent_delta',
    'agent.reflection',
    'agent.retry_scheduled',
    'agent.start',
    'background.task.completed',
    'call.agent.end',
    'call.agent.start',
    'call.tool.end',
    'call.tool.start',
    'context.compression_start',
    'context.compression_summary',
    'context.usage',
    'execution.step',
    'execution.waiting_end',
    'execution.waiting_start',
    'execution.waiting_timeout',
    'interaction.required',
    'llm.first_token',
    'output.chunk',
    'output.final_answer',
    'run.start',
    'user.interrupt',
    'user.approval_required',
    'user.input_required',
  ]);
  const _pendingUserInputSubmissions = new Map();
  const _handledRequiredInteractions = new Set();
  let _durableReplay = {
    active: false,
    runId: null,
  };

  const mergeMessageMetadata = (msg, metadata) => {
    if (!msg || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
    msg.metadata = {
      ...(msg.metadata || {}),
      ...metadata,
    };
  };

  const isVisibleRootCompressionSummary = (eventData) => {
    if (eventData.visible_to_user === false) return false;
    if (eventData.conversation_scope === 'child') return false;
    const threadKey = eventData.thread_key;
    if (threadKey != null && threadKey !== '' && threadKey !== 'root') return false;
    return true;
  };

  const eventTimestampSeconds = (event) => {
    const ts = Number(event?.timestamp);
    return Number.isFinite(ts) && ts > 0 ? ts : Date.now() / 1000;
  };

  const computeLatencyMs = (startSeconds, endSeconds) => {
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return null;
    return Math.max(0, Math.round((endSeconds - startSeconds) * 1000));
  };

  const resetActiveRunRuntime = () => {
    Object.assign(deps.activeRun, {
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
    Object.assign(deps.activeRun, {
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
    if (!deps.activeRun.firstTokenAt) {
      const elapsedMs = Number(eventData.elapsed_ms);
      deps.activeRun.firstTokenAt = ts;
      deps.activeRun.firstTokenLatencyMs = Number.isFinite(elapsedMs)
        ? Math.max(0, Math.round(elapsedMs))
        : computeLatencyMs(deps.activeRun.runStartedAt, ts);
    }
    deps.activeRun.latestLlmFirstTokenAt = ts;
    deps.activeRun.phase = 'llm_streaming';
    deps.activeRun.waiting = null;
  };

  const markOutputChunk = (event, content) => {
    const ts = eventTimestampSeconds(event);
    deps.activeRun.phase = 'llm_streaming';
    deps.activeRun.lastChunkAt = ts;
    deps.activeRun.outputCharCount = (deps.activeRun.outputCharCount || 0) + (content?.length || 0);
    if (!deps.activeRun.firstTokenAt) {
      deps.activeRun.firstTokenAt = ts;
      deps.activeRun.firstTokenLatencyMs = computeLatencyMs(deps.activeRun.runStartedAt, ts);
    }
  };

  const markWaitingStart = (event, eventData) => {
    deps.activeRun.phase = 'background_waiting';
    deps.activeRun.waiting = {
      waitId: eventData.wait_id || '',
      backgroundTaskIds: Array.isArray(eventData.background_task_ids) ? eventData.background_task_ids : [],
      pendingTaskIds: Array.isArray(eventData.pending_task_ids) ? eventData.pending_task_ids : [],
      pendingTaskCount: Number.isFinite(eventData.pending_task_count) ? eventData.pending_task_count : 0,
      timeoutMs: Number.isFinite(eventData.timeout_ms) ? eventData.timeout_ms : null,
      startedAt: eventTimestampSeconds(event),
    };
  };

  const markWaitingFinished = (eventData) => {
    const currentWaitId = deps.activeRun.waiting?.waitId;
    const finishedWaitId = eventData?.wait_id || '';
    if (currentWaitId && finishedWaitId && currentWaitId !== finishedWaitId) return;
    deps.activeRun.waiting = null;
    if (deps.activeRun.active) deps.activeRun.phase = 'llm_waiting_first_token';
  };

  const mergeRunEndMetadata = (event) => {
    const metadata = event.data?.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
    const normalized = {};
    for (const key of ['execution_time', 'first_token_time']) {
      const value = metadata[key];
      if (value == null) continue;
      const numericValue = Number(value);
      if (Number.isFinite(numericValue)) normalized[key] = numericValue;
    }
    if (Object.keys(normalized).length === 0) return;
    const currentMsg = deps.messages.value[deps.activeRun.assistantMsgIndex];
    mergeMessageMetadata(currentMsg, normalized);
  };

  const observeDeliverySeq = (event) => {
    const deliverySeq = Number(event?.stream_seq ?? 0);
    if (!Number.isFinite(deliverySeq) || deliverySeq <= 0) return;
    if (deps.activeRun.lastSeenSeq > 0 && deliverySeq > deps.activeRun.lastSeenSeq + 1) {
      _pendingReconciliation = true;
    }
    deps.activeRun.lastSeenSeq = deliverySeq;
  };

  const reconcileAfterGap = (sessionId, currentMsg) => {
    _pendingReconciliation = false;
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
    if (_recentSessionUpdatedFor.get(msg) === msg.content) return;
    deps.updateRecentSession(sessionId, msg.content, new Date().toISOString());
    _recentSessionUpdatedFor.set(msg, msg.content);
  };

  const extractRunId = (source) => {
    if (!source || typeof source !== 'object') return null;
    return source.run_id || source.data?.run_id || source.metadata?.run_id || null;
  };

  const getEventInteractionId = (event) => {
    if (!event || typeof event !== 'object') return '';
    return event.interaction_id
      || event.data?.interaction_id
      || event.content?.interaction_id
      || event.input_id
      || event.data?.input_id
      || event.content?.input_id
      || event.approval_id
      || event.data?.approval_id
      || event.content?.approval_id
      || '';
  };

  const getEventInteractionKind = (event, fallback = '') => {
    if (!event || typeof event !== 'object') return fallback;
    return event.kind || event.data?.kind || event.content?.kind || fallback;
  };

  const rememberRequiredInteraction = (kind, interactionId) => {
    if (!interactionId) return true;
    const key = `${kind || 'unknown'}:${interactionId}`;
    if (_handledRequiredInteractions.has(key)) return false;
    _handledRequiredInteractions.add(key);
    return true;
  };

  const normalizeUserInputRequiredData = (event, eventData = {}) => {
    const inputId = eventData.input_id || getEventInteractionId(event);
    return {
      ...eventData,
      kind: 'user_input',
      interaction_id: eventData.interaction_id || inputId,
      input_id: inputId,
    };
  };

  const normalizeApprovalRequiredData = (event, eventData = {}) => {
    const approvalId = eventData.approval_id || getEventInteractionId(event);
    return {
      ...eventData,
      kind: 'approval',
      interaction_id: eventData.interaction_id || approvalId,
      approval_id: approvalId,
    };
  };

  const isOpenWebSocket = (ws) => {
    if (!ws) return false;
    const openState = typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1;
    return ws.readyState === openState;
  };

  const clearPendingUserInputSubmission = (inputId) => {
    const pending = _pendingUserInputSubmissions.get(inputId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    _pendingUserInputSubmissions.delete(inputId);
    return pending;
  };

  const resolveUserInputSubmission = (event) => {
    const inputId = getEventInteractionId(event);
    const pending = clearPendingUserInputSubmission(inputId);
    if (!pending) return false;
    pending.resolve(event);
    return true;
  };

  const rejectUserInputSubmission = (event) => {
    const inputId = getEventInteractionId(event);
    const pending = clearPendingUserInputSubmission(inputId);
    if (!pending) return false;
    const error = new Error(event?.error || '用户输入提交失败');
    error.code = USER_INPUT_REJECTED_CODE;
    pending.reject(error);
    return true;
  };

  const isDurableOutboxReplayEnvelope = (event) => event?.replay_source === 'durable_outbox';

  const messageRunId = (msg) => msg?.run_id || msg?.metadata?.run_id || null;

  const findAssistantMessageIndexByRunId = (runId, predicate = () => true) => {
    if (!runId) return -1;
    for (let index = deps.messages.value.length - 1; index >= 0; index -= 1) {
      const msg = deps.messages.value[index];
      if (msg?.role === 'assistant' && messageRunId(msg) === runId && predicate(msg)) {
        return index;
      }
    }
    return -1;
  };

  const hasFinishedAssistantForRun = (runId) => (
    findAssistantMessageIndexByRunId(runId, msg => msg.finished === true) >= 0
  );

  const getDurableReplayRunId = (event) => extractRunId(event) || _durableReplay.runId || null;

  const ensureDurableReplayActiveRun = (event, sessionId) => {
    const runId = getDurableReplayRunId(event);
    if (hasFinishedAssistantForRun(runId)) return false;

    let assistantMsgIndex = findAssistantMessageIndexByRunId(runId, msg => msg.finished !== true);
    if (assistantMsgIndex < 0) {
      const lastMsg = deps.messages.value[deps.messages.value.length - 1];
      if (lastMsg?.role === 'assistant' && !lastMsg.finished && (!runId || !messageRunId(lastMsg))) {
        assistantMsgIndex = deps.messages.value.length - 1;
        if (runId) {
          lastMsg.run_id = runId;
          lastMsg.metadata = { ...(lastMsg.metadata || {}), run_id: runId };
        }
      }
    }
    if (assistantMsgIndex < 0) {
      deps.messages.value.push(deps.createAssistantMessage(runId ? { run_id: runId, metadata: { run_id: runId } } : undefined));
      assistantMsgIndex = deps.messages.value.length - 1;
    }

    deps.activeRun.active = true;
    deps.activeRun.assistantMsgIndex = assistantMsgIndex;
    deps.activeRun.runId = runId;
    deps.activeRun.lastSeenSeq = 0;
    if (!deps.activeRun.phase || deps.activeRun.phase === 'idle') {
      deps.activeRun.phase = 'llm_waiting_first_token';
      deps.activeRun.runStartedAt = eventTimestampSeconds(event);
    }
    deps.isLoading.value = true;
    if (runId) {
      deps.sessionTaskInfo.value = {
        ...(deps.sessionTaskInfo.value || {}),
        run_id: runId,
        session_id: sessionId,
        status: 'running',
      };
    }
    return true;
  };

  const terminalStatusFromEvent = (event) => {
    const status = event?.data?.status || event?.content?.status;
    return ['completed', 'failed', 'interrupted'].includes(status) ? status : 'completed';
  };

  const refreshMessagesAfterInactiveDurableTerminal = (sessionId) => {
    deps.deleteMessageCache(sessionId);
    deps.loadSessionMessages(sessionId, { silent: true });
  };

  const handleInactiveDurableReplayEvent = (event, sessionId) => {
    if (!_durableReplay.active || deps.activeRun.active) return false;

    const eventType = event.type;
    const runId = getDurableReplayRunId(event);
    if (runId && hasFinishedAssistantForRun(runId)) {
      if (eventType === 'run.end' || eventType === 'done') {
        deps.sessionTaskInfo.value = {
          ...(deps.sessionTaskInfo.value || {}),
          run_id: runId,
          session_id: sessionId,
          thread_alive: false,
          status: terminalStatusFromEvent(event),
        };
        deps.refreshSessionExecutionState(sessionId, { silent: true });
      }
      return true;
    }

    if (eventType === 'run.end' || eventType === 'done') {
      deps.sessionTaskInfo.value = {
        ...(deps.sessionTaskInfo.value || {}),
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

  const submitUserInputHttp = async (sessionId, inputId, value) => {
    const resp = await fetch(
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(inputId)}/respond`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'user_input', value }) }
    );
    if (!resp.ok) {
      const result = await resp.json().catch(() => ({}));
      throw new Error(result.message || `用户输入提交失败 (${resp.status})`);
    }
  };

  const submitUserInputWs = (ws, inputId, value) => new Promise((resolve, reject) => {
    if (!inputId) {
      reject(new Error('用户输入请求缺少 input_id'));
      return;
    }
    const existing = clearPendingUserInputSubmission(inputId);
    if (existing) {
      existing.reject(new Error('用户输入已重新提交'));
    }
    const timer = setTimeout(() => {
      _pendingUserInputSubmissions.delete(inputId);
      const error = new Error('用户输入提交确认超时');
      error.code = USER_INPUT_ACK_TIMEOUT_CODE;
      reject(error);
    }, USER_INPUT_ACK_TIMEOUT_MS);
    _pendingUserInputSubmissions.set(inputId, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ type: 'interaction.respond', interaction_id: inputId, kind: 'user_input', value }));
    } catch (error) {
      clearPendingUserInputSubmission(inputId);
      reject(error);
    }
  });

  const submitUserInputForSession = async (sessionId, inputId, value) => {
    const normalizedValue = String(value ?? '');
    const ws = deps.getWS?.();
    if (isOpenWebSocket(ws)) {
      try {
        await submitUserInputWs(ws, inputId, normalizedValue);
        return;
      } catch (error) {
        if (error?.code === USER_INPUT_ACK_TIMEOUT_CODE || error?.code === USER_INPUT_REJECTED_CODE) {
          throw error;
        }
        console.warn('用户输入 WS 提交失败，降级 HTTP:', error);
      }
    }
    await submitUserInputHttp(sessionId, inputId, normalizedValue);
  };

  const handleApprovalRequired = (event, eventData, sessionId) => {
    const approvalData = normalizeApprovalRequiredData(event, eventData);
    if (!rememberRequiredInteraction('approval', approvalData.approval_id)) return;
    deps.activeRun.phase = 'approval_waiting';
    deps.enqueueApproval(event, approvalData, sessionId);
  };

  const handleUserInputRequired = (event, eventData, sessionId) => {
    const inputData = normalizeUserInputRequiredData(event, eventData);
    if (!rememberRequiredInteraction('user_input', inputData.input_id)) return;
    const submitUserInput = async (inputId, value) => {
      try {
        await submitUserInputForSession(sessionId, inputId, value);
      } catch (e) {
        console.warn('用户输入提交失败:', e);
        deps.showToast(e.message || '用户输入提交失败', 'warning');
        throw e;
      }
    };
    const cancelUserInput = async () => { await deps.handleStop(); };
    // 优先使用 showUserInput 路由函数（支持内联工作栏），回退到对话框
    if (deps.showUserInput) {
      deps.showUserInput(inputData, submitUserInput, cancelUserInput);
    } else {
      deps.userInputDialogRef.value?.show(inputData, submitUserInput, cancelUserInput);
    }
  };

  const findUserMessageSavedTarget = (eventData) => {
    const requestId = eventData.request_id || null;
    if (requestId) {
      const byRequestId = deps.messages.value.find(
        msg => msg?.role === 'user' && msg.metadata?.request_id === requestId
      );
      if (byRequestId) return byRequestId;
    }
    const pendingFollowup = deps.messages.value.findLast?.(
      msg => msg?.role === 'user'
        && msg.metadata?.execution_kind === 'session_followup'
        && msg.metadata?.persistence_status === 'pending'
    );
    if (pendingFollowup) return pendingFollowup;
    return deps.messages.value[deps.activeRun.assistantMsgIndex - 1] || null;
  };

  const applyMessageSaved = (target, eventData, sessionId) => {
    if (!target) return;
    if (eventData.id != null) target.id = eventData.id;
    if (eventData.seq != null) target.seq = eventData.seq;
    target.metadata = {
      ...(target.metadata || {}),
      ...(eventData.request_id ? { request_id: eventData.request_id } : {}),
      ...(eventData.run_id ? { run_id: eventData.run_id } : {}),
      ...(eventData.task_id ? { task_id: eventData.task_id } : {}),
    };
    if (target.metadata.persistence_status) {
      delete target.metadata.persistence_status;
    }
    deps.cacheMessages(sessionId, deps.messages.value);
  };

  const rememberFinalizedRun = (sessionId, currentMsg) => {
    _lastFinalizedRun = {
      sessionId,
      runId: deps.activeRun.runId || extractRunId(currentMsg) || null,
      at: Date.now(),
    };
  };

  const isRecentlyFinalizedUpdate = (event, sessionId) => {
    const updateRunId = extractRunId(event);
    if (!updateRunId || !_lastFinalizedRun.runId) return false;
    return (
      _lastFinalizedRun.sessionId === sessionId
      && _lastFinalizedRun.runId === updateRunId
      && Date.now() - _lastFinalizedRun.at < FINALIZED_RUN_WINDOW_MS
    );
  };

  const finalizeActiveRun = (sessionId) => {
    let finalizedMsg = null;
    if (deps.activeRun.active) {
      const currentMsg = deps.messages.value[deps.activeRun.assistantMsgIndex];
      finalizedMsg = currentMsg || null;
      if (currentMsg && !currentMsg.finished) {
        currentMsg.finished = true;
        markRecentSessionUpdated(sessionId, currentMsg);
        deps.checkSituationScreenTrigger(currentMsg.content);
      }
      deps.cacheMessages(sessionId, deps.messages.value);
      rememberFinalizedRun(sessionId, currentMsg);
      deps.activeRun.active = false;
      resetActiveRunRuntime();
    }
    if (_pendingReconciliation) {
      reconcileAfterGap(sessionId, finalizedMsg);
    }
    deps.clearLlmRetryState();
    deps.isCompressing.value = false;
    deps.isLoading.value = false;
    deps.refreshSessionExecutionState(sessionId, { silent: true });
    deps.scrollToBottom();
  };

  const handleRunEvent = (event, currentMsg, sessionId) => {
    const eventData = event.data || {};
    const eventType = event.type;

    if (
      deps.llmRetryState.value
      && eventType !== 'agent.retry_scheduled'
      && (
        eventType === 'llm.first_token'
        || eventType === 'agent.intent_delta'
        || eventType === 'agent.intent_complete'
        || eventType === 'call.tool.start'
        || eventType === 'output.chunk'
        || eventType === 'output.final_answer'
        || eventType === 'agent.end'
        || eventType === 'agent.error'
        || eventType === 'done'
      )
    ) {
      deps.clearLlmRetryState();
    }

    if (eventType === 'agent.retry_scheduled') {
      const waitMs = Number.isFinite(eventData.wait_ms) ? eventData.wait_ms : Math.round((eventData.wait_seconds || 0) * 1000);
      deps.setLlmRetryState({
        scope: eventData.scope || 'chat_completion_stream',
        nextAttempt: eventData.next_attempt || ((eventData.failed_attempt || 0) + 1),
        maxAttempts: eventData.max_attempts || 1,
        waitMs,
        error: eventData.error || '',
        provider: eventData.provider || '',
        model: eventData.model || '',
      });
      deps.activeRun.phase = 'retrying';
      deps.sessionTaskInfo.value = { ...(deps.sessionTaskInfo.value || {}), status: 'running' };
    } else if (eventType === 'llm.first_token') {
      if (deps.isMasterEvent(event)) markLlmFirstToken(event, eventData);
    } else if (eventType === 'execution.waiting_start') {
      if (deps.isMasterEvent(event)) markWaitingStart(event, eventData);
    } else if (eventType === 'execution.waiting_end' || eventType === 'execution.waiting_timeout') {
      if (deps.isMasterEvent(event)) markWaitingFinished(eventData);
    } else if (eventType === 'call.tool.start') {
      if (deps.isMasterEvent(event)) deps.activeRun.phase = 'tool_running';
    } else if (eventType === 'call.tool.end') {
      if (deps.isMasterEvent(event) && deps.activeRun.phase !== 'background_waiting') {
        deps.activeRun.phase = 'llm_waiting_first_token';
      }
    } else if (eventType === 'execution.step') {
      const projector = deps.ensureExecutionProjector(currentMsg);
      deps.applyStep(projector, eventData);
      deps.syncExecutionProjection(currentMsg);
    } else if (eventType === 'output.chunk') {
      if (deps.isMasterEvent(event)) {
        currentMsg.content += eventData.content;
        markOutputChunk(event, eventData.content || '');
        deps.scrollToBottom();
      } else {
        const subtask = deps.findSubtaskByCallId(currentMsg.subtasks, event.call_id);
        if (subtask) subtask.result_summary = (subtask.result_summary || '') + eventData.content;
      }
    } else if (eventType === 'output.final_answer') {
      if (deps.isMasterEvent(event)) {
        // content 补偿：若 chunk 累积不完整，用 final_answer 的完整内容覆盖
        const serverContent = eventData.content || '';
        if (serverContent && (!currentMsg.content || currentMsg.content.length < serverContent.length)) {
          currentMsg.content = serverContent;
        }
        Object.assign(currentMsg, {
          ...(eventData.metadata ? { metadata: { ...(currentMsg.metadata || {}), ...eventData.metadata } } : {}),
          finished: true,
        });
        markRecentSessionUpdated(sessionId, currentMsg);
        deps.cacheMessages(sessionId, deps.messages.value);
        deps.checkSituationScreenTrigger(currentMsg.content);
      } else {
        const subtask = deps.findSubtaskByCallId(currentMsg.subtasks, event.call_id);
        if (subtask) {
          if (!subtask.result_summary) subtask.result_summary = eventData.content || '';
          if (subtask.status === 'running') subtask.status = 'success';
          subtask.expanded = false;
        }
      }
    } else if (eventType === 'output.message_saved') {
      const target = eventData.role === 'user'
        ? findUserMessageSavedTarget(eventData)
        : currentMsg;
      applyMessageSaved(target, eventData, sessionId);
    } else if (eventType === 'agent.end' && deps.isMasterEvent(event)) {
      if (!currentMsg.finished) {
        currentMsg.finished = true;
        markRecentSessionUpdated(sessionId, currentMsg);
        deps.checkSituationScreenTrigger(currentMsg.content);
      }
    } else if (eventType === 'agent.error') {
      currentMsg.status.push({ type: 'error', content: eventData.error || eventData.content });
    } else if (eventType === 'agent.reflection') {
      if (deps.isMasterEvent(event)) deps.activeRun.phase = 'reflecting';
    } else if (eventType === 'context.usage') {
      if (eventData.compressing) deps.isCompressing.value = true;
      const agentName = event.agent_name;
      const ctx = { used: eventData.used_tokens, max: eventData.budget_tokens };
      if (deps.isRootEvent(event)) {
        deps.contextUsage.value = ctx;
      } else {
        const subtask = deps.findRunningSubtaskByAgentName(currentMsg.subtasks, agentName);
        if (subtask) subtask.ctx = ctx;
      }
    } else if (eventType === 'context.compression_start') {
      deps.isCompressing.value = true;
    } else if (eventType === 'context.compression_summary') {
      deps.isCompressing.value = false;
      if (!isVisibleRootCompressionSummary(eventData)) return;
      const summaryContent = eventData.content || '';
      const alreadyExists = deps.messages.value.some(
        m => m.metadata?.compression && m.content === summaryContent
      );
      if (!alreadyExists) {
        const compressionMsg = {
          role: 'system',
          content: summaryContent,
          metadata: {
            compression: true,
            ...(eventData.thread_key != null ? { thread_key: eventData.thread_key } : {}),
            ...(eventData.conversation_scope != null ? { conversation_scope: eventData.conversation_scope } : {}),
            ...(eventData.visible_to_user != null ? { visible_to_user: eventData.visible_to_user } : {}),
            ...(eventData.child_agent_id != null ? { child_agent_id: eventData.child_agent_id } : {}),
            ...(eventData.run_id != null ? { run_id: eventData.run_id } : {}),
          },
        };
        deps.messages.value.splice(deps.activeRun.assistantMsgIndex, 0, compressionMsg);
        deps.activeRun.assistantMsgIndex++;
      }
    } else if (eventType === 'interaction.required') {
      const kind = getEventInteractionKind(event, eventData.input_id ? 'user_input' : '');
      if (kind === 'approval') {
        handleApprovalRequired(event, eventData, sessionId);
      } else if (kind === 'user_input') {
        handleUserInputRequired(event, eventData, sessionId);
      }
    } else if (eventType === 'user.approval_required') {
      handleApprovalRequired(event, eventData, sessionId);
    } else if (eventType === 'user.input_required') {
      handleUserInputRequired(event, eventData, sessionId);
    }

    deps.scrollToBottom();
  };

  const handleWSMessage = (event, sessionId) => {
    if (sessionId !== deps.currentSessionId.value) return;

    const eventType = event.type;

    if (eventType === 'heartbeat') return;
    if (deps.activeRun.isReplaying && eventType === 'done') return;

    // 统一推进投递序号（内部对无效 seq 自动跳过）
    if (deps.activeRun.active || deps.isLoading.value) {
      observeDeliverySeq(event);
    }

    if (eventType === 'reconnect_start') {
      deps.clearSessionResumeRecovery();
      deps.activeRun.isReplaying = true;
      if (isDurableOutboxReplayEnvelope(event)) {
        _durableReplay = {
          active: true,
          runId: event.run_id || null,
        };
        return;
      }
      _durableReplay = { active: false, runId: null };
      if (!deps.isLoading.value) {
        deps.isLoading.value = true;
        const lastMsg = deps.messages.value[deps.messages.value.length - 1];
        if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.finished) {
          deps.messages.value.push(deps.createAssistantMessage());
        }
        deps.activeRun.active = true;
        deps.activeRun.assistantMsgIndex = deps.messages.value.length - 1;
        deps.activeRun.runId = event.run_id || null;
        deps.activeRun.lastSeenSeq = 0;
        if (!deps.activeRun.phase || deps.activeRun.phase === 'idle') {
          deps.activeRun.phase = 'llm_waiting_first_token';
          deps.activeRun.runStartedAt = eventTimestampSeconds(event);
        }
      }
      if (event.run_id) {
        deps.sessionTaskInfo.value = {
          ...(deps.sessionTaskInfo.value || {}),
          run_id: event.run_id,
          session_id: sessionId,
          status: 'running',
        };
      }
      return;
    }
    if (eventType === 'reconnect_end') {
      if (isDurableOutboxReplayEnvelope(event)) {
        _durableReplay = { active: false, runId: null };
      }
      deps.activeRun.isReplaying = false;
      return;
    }

    if (handleInactiveDurableReplayEvent(event, sessionId)) return;

    if (eventType === 'send.ack') {
      deps.clearCommandFallback();
      const ackData = event;
      if (!ackData.started && ackData.kind !== 'command') {
        const currentMsg = deps.messages.value[deps.activeRun.assistantMsgIndex];
        if (currentMsg) {
          currentMsg.content = `\n\n[System Error: ${ackData.error || '启动执行失败'}]`;
          currentMsg.finished = true;
        }
        deps.sessionTaskInfo.value = { ...(deps.sessionTaskInfo.value || {}), status: 'failed' };
        deps.activeRun.active = false;
        resetActiveRunRuntime();
        deps.isLoading.value = false;
        return;
      }
      if (ackData.kind === 'command' && !ackData.started) {
        deps.scheduleCommandFallback(sessionId, deps.activeRun.assistantMsgIndex);
        return;
      }
      deps.activeRun.runId = ackData.run_id || null;
      if (deps.activeRun.active && startupPhases.has(deps.activeRun.phase)) {
        deps.activeRun.phase = 'llm_waiting_first_token';
      }
      if (ackData.kind === 'command') {
        deps.scheduleCommandFallback(sessionId, deps.activeRun.assistantMsgIndex, 60000);
      }
      return;
    }

    if (eventType === 'send.error') {
      deps.clearCommandFallback();
      const currentMsg = deps.messages.value[deps.activeRun.assistantMsgIndex];
      if (currentMsg) {
        currentMsg.content = `\n\n[System Error: ${event.error || 'Request failed'}]`;
        currentMsg.finished = true;
      }
      deps.sessionTaskInfo.value = { ...(deps.sessionTaskInfo.value || {}), status: 'failed' };
      deps.activeRun.active = false;
      deps.isLoading.value = false;
      deps.showToast('消息发送失败', 'warning');
      return;
    }

    if (eventType === 'interaction.error') {
      const kind = getEventInteractionKind(event);
      const interactionId = getEventInteractionId(event);
      if (kind === 'user_input') {
        const handled = rejectUserInputSubmission(event);
        if (!handled) deps.showToast(event.error || '用户输入提交失败', 'warning');
        return;
      }
      if (kind === 'approval') {
        deps.handleApprovalResolved(interactionId, sessionId);
        deps.showToast(event.error || '审批提交失败', 'warning');
        return;
      }
      if (!rejectUserInputSubmission(event)) {
        deps.showToast(event.error || '交互提交失败', 'warning');
      }
      return;
    }

    if (eventType === 'interaction.ack') {
      const kind = getEventInteractionKind(event);
      const interactionId = getEventInteractionId(event);
      if (kind === 'user_input') {
        resolveUserInputSubmission(event);
        return;
      }
      if (kind === 'approval') {
        if (deps.activeRun.active && deps.activeRun.phase === 'approval_waiting') {
          deps.activeRun.phase = event.data?.approved === false ? 'llm_waiting_first_token' : 'tool_running';
        }
        deps.handleApprovalResolved(interactionId, sessionId);
        return;
      }
      resolveUserInputSubmission(event);
      return;
    }

    if (eventType === 'approve.error') {
      if (event.approval_id) {
        deps.handleApprovalResolved(event.approval_id, sessionId);
      }
      deps.showToast(event.error || '审批提交失败', 'warning');
      return;
    }
    if (eventType === 'user.approval_granted' || eventType === 'user.approval_denied') {
      if (deps.activeRun.active && deps.activeRun.phase === 'approval_waiting') {
        deps.activeRun.phase = eventType === 'user.approval_granted' ? 'tool_running' : 'llm_waiting_first_token';
      }
      const approvalId = event.data?.approval_id || event.approval_id || '';
      deps.handleApprovalResolved(approvalId, sessionId);
      return;
    }

    if (eventType === 'user_input.error') {
      const handled = rejectUserInputSubmission(event);
      if (!handled) deps.showToast(event.error || '用户输入提交失败', 'warning');
      return;
    }
    if (eventType === 'user_input.ack') {
      resolveUserInputSubmission(event);
      return;
    }
    if (eventType === 'session.run_started') {
      _pendingReconciliation = false; // 新 run 重置 gap 标记
      const nextRunId = event.run_id || event.data?.run_id || null;
      const shouldStartNewMessage = !deps.activeRun.active || (deps.activeRun.runId && nextRunId && deps.activeRun.runId !== nextRunId);
      if (shouldStartNewMessage) {
        const currentMsg = deps.messages.value[deps.activeRun.assistantMsgIndex];
        if (currentMsg && !currentMsg.finished) {
          currentMsg.finished = true;
        }

        const hasNotificationMsg = deps.messages.value.some(
          msg => msg.role === 'user' && msg.metadata?.source === 'system.bg_notification' && msg._bgRunId === nextRunId
        );
        if (!hasNotificationMsg) {
          deps.messages.value.push(deps.buildTaskNotificationMessage(sessionId, event));
        }

        deps.messages.value.push(deps.createAssistantMessage({ run_id: nextRunId }));
        deps.activeRun.active = true;
        deps.activeRun.assistantMsgIndex = deps.messages.value.length - 1;
        deps.activeRun.lastSeenSeq = 0;
        deps.activeRun.isReplaying = _durableReplay.active;
        startActiveRunRuntime(event);
      }
      deps.activeRun.runId = nextRunId;
      if (deps.activeRun.phase === 'idle' || !deps.activeRun.runStartedAt || startupPhases.has(deps.activeRun.phase)) {
        startActiveRunRuntime(event);
      }
      deps.isLoading.value = true;
      deps.sessionTaskInfo.value = {
        ...(deps.sessionTaskInfo.value || {}),
        run_id: nextRunId,
        session_id: sessionId,
        status: 'running',
      };
      deps.refreshSessionExecutionState(sessionId, { silent: true });
      nextTick(() => deps.scrollToBottom(true));
      return;
    }

    if (eventType === 'command.result') {
      const cmdData = event.data || event;
      if (cmdData.type === 'command.started') {
        deps.scheduleCommandFallback(sessionId, deps.activeRun.assistantMsgIndex, 120000);
        return;
      }
      deps.clearCommandFallback();
      let targetIndex = deps.messages.value.length - 1;
      let targetMsg = deps.messages.value[targetIndex];
      if (!targetMsg || targetMsg.role !== 'assistant' || targetMsg.finished) {
        deps.messages.value.push(deps.createAssistantMessage());
        targetIndex = deps.messages.value.length - 1;
        targetMsg = deps.messages.value[targetIndex];
      }
      targetMsg.content = cmdData.content || '';
      targetMsg.metadata = {
        ...targetMsg.metadata,
        type: 'command_result',
        command: cmdData.command || 'unknown',
        success: cmdData.success !== false,
        error: cmdData.error || null,
        data: cmdData.data || null,
      };
      targetMsg.finished = true;
      deps.isLoading.value = false;
      deps.deleteMessageCache(sessionId);
      deps.loadSessionMessages(sessionId, { silent: true });
      nextTick(() => deps.scrollToBottom(true));
      return;
    }

    if (eventType === 'session.updated') {
      if (isRecentlyFinalizedUpdate(event, sessionId)) {
        if (typeof deps.mergeMessageIdsFromServer === 'function') {
          deps.mergeMessageIdsFromServer(sessionId);
        }
        deps.refreshSessionExecutionState(sessionId, { silent: true });
        return;
      }
      if (!deps.isLoading.value && !deps.activeRun.active) {
        deps.deleteMessageCache(sessionId);
        deps.loadSessionMessages(sessionId, { silent: true });
      }
      return;
    }

    if (eventType === 'run.end' || eventType === 'done') {
      if (eventType === 'run.end') mergeRunEndMetadata(event);
      deps.sessionTaskInfo.value = {
        ...(deps.sessionTaskInfo.value || {}),
        thread_alive: false,
        status: 'completed',
      };
      finalizeActiveRun(sessionId);
      return;
    }

    if (deps.activeRun.active) {
      const currentMsg = deps.messages.value[deps.activeRun.assistantMsgIndex];
      if (currentMsg) {
        deps.mergeExecutionObservability(event);
        handleRunEvent(event, currentMsg, sessionId);
      }
    }
  };

  return {
    handleRunEvent,
    handleWSMessage,
    finalizeActiveRun,
  };
}
