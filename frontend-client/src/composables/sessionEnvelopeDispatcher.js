// @ts-check
import { nextTick } from 'vue';
import { sessionLoadStrategyRestoresActiveRun } from '@ragsystem/agent-protocol';
import { createSessionEventReducer } from './sessionEventReducer.js';
import { createUserMessage } from './sessionCommandController.js';
import { getMessageAttachments, normalizeMessageContentParts } from '../utils/messageContentParts.js';

const startupPhases = new Set(['creating_session', 'preparing_attachments', 'starting_agent']);

/** @typedef {Record<string, any>} AnyRecord */
/** @param {unknown} error */
const errorMessage = error => error instanceof Error ? error.message : String(error);

/** @param {import('./sessionCoreTypes.js').DispatcherOptions} options */
export function createSessionEnvelopeDispatcher({
  deps,
  state,
  runtime,
  recovery,
  interaction,
  applySessionRuntime,
  finishOptimisticCommand,
  onRuntimeSnapshot,
  getStop,
  takeFollowupCandidate,
  bindUnassignedFollowupCandidates,
}) {
  const {
    currentSessionId,
    messages,
    isLoading,
    isCompressing,
    contextUsage,
    llmRetryState,
    activeRun,
  } = state;
  const {
    clearCommandFallback,
    scheduleCommandFallback,
  } = recovery;
  const presentedInteractions = new Map();
  /** @param {import('./sessionCoreTypes.js').SessionEnvelope} event */
  const getEventInteractionId = event => event?.call_id || '';

  /** @param {import('./sessionCoreTypes.js').SessionEnvelope} event @param {AnyRecord} [eventData] */
  const normalizeUserInputRequiredData = (event, eventData = {}) => {
    const inputId = eventData.input_id || getEventInteractionId(event);
    const inputSchema = eventData.input && typeof eventData.input === 'object' ? eventData.input : {};
    return {
      ...eventData,
      ...inputSchema,
      kind: 'user_input',
      interaction_id: eventData.interaction_id || inputId,
      input_id: inputId,
    };
  };

  /** @param {import('./sessionCoreTypes.js').SessionEnvelope} event @param {AnyRecord} [eventData] */
  const normalizeApprovalRequiredData = (event, eventData = {}) => {
    const approvalId = eventData.approval_id || getEventInteractionId(event);
    return {
      ...eventData,
      kind: 'approval',
      interaction_id: eventData.interaction_id || approvalId,
      approval_id: approvalId,
    };
  };

  const resetStreamSessionState = () => {
    runtime.resetInternal();
    interaction.reset();
    presentedInteractions.clear();
  };

  const resetInteractionPresentation = () => {
    interaction.reset();
    presentedInteractions.clear();
  };

  /** @param {import('./sessionCoreTypes.js').SessionEnvelope} event @param {AnyRecord} eventData @param {string} sessionId */
  const handleApprovalRequired = (event, eventData, sessionId) => {
    const approvalData = normalizeApprovalRequiredData(event, eventData);
    activeRun.phase = 'approval_waiting';
    deps.enqueueApproval(event, approvalData, sessionId);
  };

  /** @param {import('./sessionCoreTypes.js').SessionEnvelope} event @param {AnyRecord} eventData */
  const handleUserInputRequired = (event, eventData) => {
    const inputData = normalizeUserInputRequiredData(event, eventData);
    /** @param {string} inputId @param {unknown} value */
    const submitUserInput = async (inputId, value) => {
      try {
        await interaction.respond(inputId, { kind: 'user_input', value });
      } catch (error) {
        console.warn('用户输入提交失败:', error);
        deps.showToast(errorMessage(error) || '用户输入提交失败', 'warning');
        throw error;
      }
    };
    const cancelUserInput = async () => { await getStop()(); };
    if (deps.showUserInput) {
      deps.showUserInput(inputData, submitUserInput, cancelUserInput);
    } else {
      deps.userInputDialogRef.value?.show(inputData, submitUserInput, cancelUserInput);
    }
  };

  /** @param {AnyRecord} eventData */
  const findUserMessageSavedTarget = (eventData) => {
    const requestId = eventData.request_id || null;
    if (requestId) {
      const byRequestId = messages.value.find(
        /** @param {AnyRecord} message */
        message => message?.role === 'user' && message.metadata?.request_id === requestId,
      );
      if (byRequestId) return byRequestId;
    }
    const pendingFollowup = messages.value.findLast?.(
      /** @param {AnyRecord} message */
      message => message?.role === 'user'
        && message.metadata?.execution_kind === 'session_followup'
        && message.metadata?.persistence_status === 'pending',
    );
    if (pendingFollowup) return pendingFollowup;
    const precedingMessage = messages.value[activeRun.assistantMsgIndex - 1] || null;
    return precedingMessage?.role === 'user' ? precedingMessage : null;
  };

  /** @param {import('./sessionCoreTypes.js').SessionMessage} message */
  const getMessageRunId = message => message?.run_id || message?.metadata?.run_id || null;

  /** @param {import('./sessionCoreTypes.js').SessionMessage | null | undefined} message */
  const getMessageExecutionRunIds = message => Array.isArray(message?.metadata?.execution_run_ids)
    ? message.metadata.execution_run_ids.filter(value => typeof value === 'string' && value)
    : [];

  /** @param {string | null | undefined} runId */
  const findExecutionMessage = runId => !runId ? null : messages.value.find(message => message?.role === 'assistant'
    && (getMessageRunId(message) === runId || getMessageExecutionRunIds(message).includes(runId))) || null;

  /** @param {import('./sessionCoreTypes.js').SessionMessage} message @param {string} runId */
  const bindExecutionRun = (message, runId) => {
    const runIds = new Set(getMessageExecutionRunIds(message));
    runIds.add(runId);
    message.metadata = { ...(message.metadata || {}), execution_run_ids: [...runIds] };
  };

  /** @param {import('./sessionCoreTypes.js').SessionMessage} candidate @param {AnyRecord} eventData @returns {import('./sessionCoreTypes.js').SessionMessage} */
  const asConfirmedRunInjection = (candidate, eventData) => {
    const { persistence_status: _persistenceStatus, ...metadata } = candidate.metadata || {};
    return {
      ...candidate,
      status: [],
      metadata: {
        ...metadata,
        ...(eventData.request_id ? { request_id: eventData.request_id } : {}),
        ...(eventData.run_id ? { run_id: eventData.run_id } : {}),
        ...(eventData.task_id ? { task_id: eventData.task_id } : {}),
        ...(Number.isInteger(eventData.round_index) ? { round_index: eventData.round_index } : {}),
        execution_kind: 'session_followup',
        source: 'running_session',
      },
    };
  };

  /** @param {import('./sessionCoreTypes.js').SessionMessage} candidate @param {AnyRecord} eventData @returns {import('./sessionCoreTypes.js').SessionMessage} */
  const asNewRunUserMessage = (candidate, eventData) => {
    const {
      persistence_status: _persistenceStatus,
      source: _source,
      round_index: _roundIndex,
      ...metadata
    } = candidate.metadata || {};
    return {
      ...candidate,
      status: [],
      metadata: {
        ...metadata,
        ...(eventData.request_id ? { request_id: eventData.request_id } : {}),
        ...(eventData.run_id ? { run_id: eventData.run_id } : {}),
        ...(eventData.task_id ? { task_id: eventData.task_id } : {}),
        execution_kind: 'agent_stream',
      },
    };
  };

  /** @param {import('./sessionCoreTypes.js').SessionMessage} message @param {string | null | undefined} runId @returns {import('./sessionCoreTypes.js').SessionMessage} */
  const insertNewRunUserMessage = (message, runId) => {
    const assistantIndex = messages.value.findIndex(
      item => item?.role === 'assistant' && getMessageRunId(item) === runId,
    );
    if (assistantIndex < 0) {
      messages.value.push(message);
      return message;
    }
    messages.value.splice(assistantIndex, 0, message);
    if (activeRun.assistantMsgIndex >= assistantIndex) activeRun.assistantMsgIndex += 1;
    return message;
  };

  /**
   * 服务端以实际落库时是否仍有活跃 root run 决定 followup 或新 run。
   * 相同 run_id 表示并入既有 run；不同 run_id 表示旧 run 已结束，需按普通用户消息展示。
   * @param {import('./sessionCoreTypes.js').SessionMessage} candidate @param {AnyRecord} eventData
   */
  const commitFollowupCandidate = (candidate, eventData) => {
    const expectedRunId = candidate.metadata?.run_id || null;
    const persistedRunId = eventData.run_id || null;
    if (expectedRunId && persistedRunId && expectedRunId === persistedRunId) {
      const injection = asConfirmedRunInjection(candidate, eventData);
      messages.value.push(injection);
      return { message: injection, kind: 'run_injection' };
    }
    const userMessage = asNewRunUserMessage(candidate, eventData);
    insertNewRunUserMessage(userMessage, persistedRunId);
    return { message: userMessage, kind: 'new_run' };
  };

  /** @param {AnyRecord | null | undefined} target @param {AnyRecord} eventData @param {string} sessionId */
  const applyMessageSaved = (target, eventData, sessionId) => {
    if (!target) return;
    const messageId = eventData.message_id ?? eventData.id;
    if (messageId != null) target.id = messageId;
    if (eventData.seq != null) target.seq = eventData.seq;
    if (Array.isArray(eventData.content_parts)) {
      target.content_parts = normalizeMessageContentParts(eventData.content_parts);
      if (target.role === 'user') target.attachments = getMessageAttachments(target);
    }
    target.metadata = {
      ...(target.metadata || {}),
      ...(eventData.request_id ? { request_id: eventData.request_id } : {}),
      ...(eventData.run_id ? { run_id: eventData.run_id } : {}),
      ...(eventData.task_id ? { task_id: eventData.task_id } : {}),
    };
    if (target.metadata.persistence_status) delete target.metadata.persistence_status;
    deps.cacheMessages(sessionId, messages.value);
  };

  const handleRunEvent = createSessionEventReducer({
    deps,
    runtime,
    activeRun,
    messages,
    isCompressing,
    contextUsage,
    llmRetryState,
    handleApprovalRequired,
    handleUserInputRequired,
  });

  /** @param {AnyRecord} snapshot @param {string} sessionId */
  const applyRuntimeSnapshot = (snapshot, sessionId) => {
    applySessionRuntime(snapshot);
    const retryModel = snapshot.active_run?.activity?.models?.find(
      /** @param {AnyRecord} model */ model => model.status === 'retry_wait',
    );
    if (retryModel) {
      const nextRetryAt = retryModel.retry_at ? Date.parse(retryModel.retry_at) : Date.now();
      deps.setLlmRetryState({
        scope: 'model_attempt',
        callId: retryModel.call_id,
        agentId: retryModel.agent_id || '',
        nextAttempt: (retryModel.attempt || 0) + 1,
        maxAttempts: retryModel.max_attempts || 1,
        waitMs: Number.isFinite(nextRetryAt) ? Math.max(0, nextRetryAt - Date.now()) : 0,
        nextRetryAt: Number.isFinite(nextRetryAt) ? nextRetryAt : Date.now(),
        error: retryModel.error || '',
        provider: retryModel.provider || '',
        model: retryModel.model || '',
      });
    } else if (llmRetryState.value) {
      deps.clearLlmRetryState();
    }
    onRuntimeSnapshot?.(sessionId, snapshot);
    const presentableInteractions = (snapshot.pending_interactions || []).filter(
      /** @param {AnyRecord} item */
      item => item.status !== 'resolved',
    );
    const nextInteractions = new Map(presentableInteractions.map(
      /** @param {AnyRecord} item */
      item => [item.interaction_id, item],
    ));
    for (const [interactionId, previous] of presentedInteractions) {
      const current = nextInteractions.get(interactionId);
      if (current && current.status === previous.status && current.kind === previous.kind) continue;
      if (previous.kind === 'approval') deps.handleApprovalResolved(interactionId, sessionId);
      else deps.handleUserInputResolved?.(interactionId);
      presentedInteractions.delete(interactionId);
    }
    for (const pending of presentableInteractions) {
      const previous = presentedInteractions.get(pending.interaction_id);
      if (previous && previous.status === pending.status && previous.kind === pending.kind) continue;
      const event = /** @type {import('./sessionCoreTypes.js').SessionEnvelope} */ ({
        type: 'interaction',
        session_id: sessionId,
        call_id: pending.interaction_id,
        run_id: pending.run_id,
        payload: pending.payload,
      });
      const eventData = { ...pending.payload, interaction_status: pending.status };
      if (pending.kind === 'approval') {
        deps.enqueueApproval(event, normalizeApprovalRequiredData(event, eventData), sessionId);
      } else {
        handleUserInputRequired(event, eventData);
      }
      presentedInteractions.set(pending.interaction_id, { kind: pending.kind, status: pending.status });
    }
    if (!snapshot.active_run || !sessionLoadStrategyRestoresActiveRun(snapshot.load_strategy)) return;
    const runId = snapshot.active_run.run_id;
    let assistantMsgIndex = messages.value.findIndex(message => message?.role === 'assistant'
      && (message?.run_id === runId || message?.metadata?.run_id === runId)
      && message.finished !== true);
    if (assistantMsgIndex < 0) {
      const lastMessage = messages.value[messages.value.length - 1];
      if (lastMessage?.role === 'assistant' && !lastMessage.finished) {
        assistantMsgIndex = messages.value.length - 1;
        lastMessage.run_id = runId;
        lastMessage.metadata = { ...(lastMessage.metadata || {}), run_id: runId };
      } else {
        messages.value.push(deps.createAssistantMessage({ run_id: runId, metadata: { run_id: runId } }));
        assistantMsgIndex = messages.value.length - 1;
      }
    }
    activeRun.assistantMsgIndex = assistantMsgIndex;
    activeRun.runId = runId;
    if (!activeRun.phase || activeRun.phase === 'idle') activeRun.phase = 'processing';
  };

  /** @param {import('./sessionCoreTypes.js').SessionEnvelope} event @param {string} sessionId */
  const handleEnvelope = (event, sessionId) => {
    if (sessionId !== currentSessionId.value) return;

    const eventType = event.type;
    const payload = event.payload || {};

    if (eventType === 'heartbeat') return;
    if (eventType === 'session.runtime') {
      applyRuntimeSnapshot(payload, sessionId);
      return;
    }
    if (activeRun.active || isLoading.value) runtime.observeDeliverySeq(event);

    if (eventType === 'session.reconnect') {
      const phase = payload.phase;
      activeRun.isReplaying = true;
      if (phase === 'start') {
        if (runtime.isDurableOutboxReplayEnvelope(event)) {
          runtime.setDurableReplay({ active: true, runId: event.run_id || null });
          return;
        }
        if (runtime.isActiveRunSnapshotReplayEnvelope(event) && Number(payload.replay_count) > 0) {
          runtime.resetActiveRunPresentation(event.run_id || null);
        }
        runtime.setDurableReplay({ active: false });
        return;
      }
      if (runtime.isDurableOutboxReplayEnvelope(event)) runtime.setDurableReplay({ active: false });
      activeRun.isReplaying = false;
      return;
    }

    if (runtime.handleInactiveDurableReplayEvent(event, sessionId)) return;

    if (eventType === 'ack') {
      const category = payload.category;
      if (category === 'send') {
        clearCommandFallback();
        if (!payload.ok) {
          const currentMsg = messages.value[activeRun.assistantMsgIndex];
          if (currentMsg) {
            currentMsg.content = `\n\n[System Error: ${payload.error || '启动执行失败'}]`;
            currentMsg.finished = true;
          }
          finishOptimisticCommand();
          runtime.resetActiveRunRuntime();
          return;
        }
        return;
      }
      if (category === 'stop') return;
      if (category === 'interaction') {
        const refCallId = payload.ref_call_id || '';
        if (payload.ok) {
          if (interaction.hasPending(refCallId)) interaction.resolve(refCallId);
          return;
        }
        if (interaction.hasPending(refCallId)) {
          interaction.reject(refCallId, payload.error || '用户输入提交失败');
          return;
        }
        deps.showToast(payload.error || '交互提交失败', 'warning');
        return;
      }
      return;
    }

    if (eventType === 'error') {
      const currentMsg = messages.value[activeRun.assistantMsgIndex];
      if (currentMsg) currentMsg.status.push({ type: 'error', content: payload.message || '' });
      return;
    }

    if (eventType === 'interaction' && payload.phase === 'responded') {
      const refCallId = event.call_id || '';
      if (interaction.hasPending(refCallId)) interaction.resolve(refCallId);
      return;
    }

    if (eventType === 'interaction' && payload.phase === 'required') return;

    if (eventType === 'run_started') {
      runtime.resetPendingReconciliation();
      const nextRunId = event.run_id || null;
      bindUnassignedFollowupCandidates(nextRunId);
      let currentAssistantIndex = activeRun.assistantMsgIndex;
      let currentMsg = messages.value[currentAssistantIndex];
      // An idle runtime reconciliation resets the active-run index. Recover
      // the optimistic unfinished assistant that was just added by send().
      if (currentMsg?.role !== 'assistant' || currentMsg.finished) {
        currentAssistantIndex = -1;
        for (let index = messages.value.length - 1; index >= 0; index -= 1) {
          const candidate = messages.value[index];
          if (candidate?.role === 'assistant' && !candidate.finished) {
            currentAssistantIndex = index;
            currentMsg = candidate;
            break;
          }
        }
      }
      const currentMsgRunId = getMessageRunId(currentMsg);
      // The connection handshake can deliver an idle runtime snapshot between
      // the optimistic assistant placeholder and run_started. Reuse that
      // unfinished placeholder instead of appending a second assistant.
      const canReuseCurrentAssistant = currentMsg?.role === 'assistant'
        && !currentMsg.finished
        && (!activeRun.runId || !nextRunId || activeRun.runId === nextRunId)
        && (!currentMsgRunId || !nextRunId || currentMsgRunId === nextRunId);
      const shouldStartNewMessage = !canReuseCurrentAssistant;
      if (shouldStartNewMessage) {
        if (currentMsg && !currentMsg.finished) currentMsg.finished = true;
        const startedCandidate = payload.request_id
          ? takeFollowupCandidate(payload.request_id)
          : null;
        if (startedCandidate) {
          const userMessage = asNewRunUserMessage(startedCandidate, {
            request_id: payload.request_id,
            run_id: nextRunId,
          });
          insertNewRunUserMessage(userMessage, nextRunId);
          deps.cacheMessages(sessionId, messages.value);
          deps.updateRecentSession(sessionId, userMessage.content, new Date().toISOString());
        }
        const systemUserMessageSource = event.payload?.source === 'system.bg_notification'
          ? 'background_notification'
          : event.payload?.source === 'system.goal_continuation'
            ? 'goal_continuation'
            : null;
        if (systemUserMessageSource && event.payload?.task) {
          messages.value.push(createUserMessage(event.payload.task, [], {
            source: systemUserMessageSource,
            request_id: event.payload?.request_id || null,
            run_id: nextRunId,
          }));
        }
        messages.value.push(deps.createAssistantMessage({ run_id: nextRunId }));
        activeRun.assistantMsgIndex = messages.value.length - 1;
        activeRun.lastSeenSeq = 0;
        activeRun.isReplaying = runtime.isDurableReplayActive();
        runtime.startActiveRunRuntime(event);
      } else {
        activeRun.assistantMsgIndex = currentAssistantIndex;
        activeRun.active = true;
        if (currentMsg && nextRunId) {
          currentMsg.run_id = nextRunId;
          currentMsg.metadata = { ...(currentMsg.metadata || {}), run_id: nextRunId };
          bindExecutionRun(currentMsg, nextRunId);
        }
      }
      activeRun.runId = nextRunId;
      if (activeRun.phase === 'idle' || !activeRun.runStartedAt || startupPhases.has(activeRun.phase)) {
        runtime.startActiveRunRuntime(event);
      }
      nextTick(() => deps.scrollToBottom(true));
      return;
    }

    if (eventType === 'state_sync') {
      const category = payload.category;
      if (category === 'message_saved') {
        const ref = { ...(payload.ref || {}), ...(event.run_id ? { run_id: event.run_id } : {}) };
        let currentMsg = messages.value[activeRun.assistantMsgIndex];
        const candidate = ref.role === 'user' && ref.request_id
          ? takeFollowupCandidate(ref.request_id)
          : null;
        const committedCandidate = candidate ? commitFollowupCandidate(candidate, ref) : null;
        const refMessageId = ref.message_id || ref.id || null;
        const refRunId = ref.run_id || null;
        const matchingAssistant = ref.role === 'assistant'
          ? messages.value.find(message => message?.role === 'assistant'
            && ((refMessageId && message.id === refMessageId)
              || (refRunId && getMessageRunId(message) === refRunId)))
          : null;
        const activeRunId = activeRun.runId || getMessageRunId(currentMsg);
        if (ref.role === 'assistant'
          && refRunId
          && activeRunId
          && refRunId !== activeRunId
          && !matchingAssistant) {
          return;
        }
        let target = committedCandidate?.message
          || (ref.role === 'user'
            ? findUserMessageSavedTarget(ref)
            : matchingAssistant || (refRunId && getMessageRunId(currentMsg) === refRunId ? currentMsg : null));
        if (!target && ref.role === 'assistant' && Array.isArray(ref.content_parts)) {
          const contentParts = normalizeMessageContentParts(ref.content_parts);
          const content = contentParts
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('');
          const created = deps.createAssistantMessage({
            id: ref.message_id || ref.id,
            seq: ref.seq,
            content,
            content_parts: contentParts,
            finished: true,
            has_execution: true,
            run_id: refRunId,
            metadata: { run_id: refRunId },
          });
          messages.value.push(created);
          if (!activeRunId || !refRunId || activeRunId === refRunId) {
            activeRun.assistantMsgIndex = messages.value.length - 1;
          }
          currentMsg = created;
          target = created;
        }
        applyMessageSaved(target, ref, sessionId);
        if (target?.role === 'assistant' && refRunId) target.has_execution = true;
        if (committedCandidate) {
          deps.updateRecentSession(sessionId, committedCandidate.message.content, new Date().toISOString());
        }
        return;
      }
      if (category === 'session_updated') {
        if (payload.detail?.entity === 'background_task') {
          deps.handleBackgroundTaskLifecycle?.(payload.detail);
          return;
        }
        if (runtime.isRecentlyFinalizedUpdate(event, sessionId)) {
          if (typeof deps.mergeMessageIdsFromServer === 'function') deps.mergeMessageIdsFromServer(sessionId);
          return;
        }
        if (!isLoading.value && !activeRun.active) {
          deps.deleteMessageCache(sessionId);
          deps.loadSessionMessages(sessionId, { silent: true });
        }
        return;
      }
      if (category === 'command_result') {
        const detail = payload.detail || {};
        if (detail.type === 'command.started') {
          scheduleCommandFallback(sessionId, activeRun.assistantMsgIndex, 120000);
          return;
        }
        clearCommandFallback();
        let targetMsg = messages.value[messages.value.length - 1];
        if (!targetMsg || targetMsg.role !== 'assistant' || targetMsg.finished) {
          messages.value.push(deps.createAssistantMessage());
          targetMsg = messages.value[messages.value.length - 1];
        }
        targetMsg.content = detail.content || '';
        targetMsg.content_parts = [{
          type: 'command_result',
          invocation_id: detail.invocation_id || 'pending-command',
          name: detail.command || 'unknown',
          success: detail.success !== false,
          text: detail.content || '',
          ...(detail.error ? { error: detail.error } : {}),
        }];
        targetMsg.finished = true;
        finishOptimisticCommand();
        deps.deleteMessageCache(sessionId);
        deps.loadSessionMessages(sessionId, { silent: true });
        nextTick(() => deps.scrollToBottom(true));
        return;
      }
    }

    if (eventType === 'run_ended') {
      const eventRunId = event.run_id || null;
      const isReplayChild = runtime.isDurableReplayActive()
        && typeof payload.lineage?.parent_call_id === 'string'
        && payload.lineage.parent_call_id.length > 0;
      const indexedMsg = messages.value[activeRun.assistantMsgIndex];
      const currentMsg = isReplayChild
        ? indexedMsg
        : eventRunId
          ? findExecutionMessage(eventRunId)
          : indexedMsg;
      const targetRootRunId = getMessageRunId(currentMsg);
      // Child delegation runs have their own terminal event. They must not
      // finalize the parent assistant message while the root run continues.
      if (eventRunId && targetRootRunId && eventRunId !== targetRootRunId) {
        return;
      }
      const terminalStatus = runtime.terminalStatusFromEvent(event);
      if (terminalStatus === 'suspended') return;
      if (currentMsg) {
        currentMsg.finished = true;
        currentMsg.has_execution = true;
        if (eventRunId) {
          currentMsg.run_id = eventRunId;
          currentMsg.metadata = { ...(currentMsg.metadata || {}), run_id: eventRunId };
        }
        const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
        if (terminalStatus === 'interrupted') {
          const displayReason = {
            session_stopped: '用户主动停止运行',
            backend_restarted: '后端重启导致运行中断',
            run_lease_expired: '运行租约过期导致运行中断',
          }[reason] || reason || '未提供中断原因';
          currentMsg.metadata = {
            ...(currentMsg.metadata || {}),
            terminal_status: 'interrupted',
            terminal_reason: reason || '未提供中断原因',
            interrupted: true,
          };
          currentMsg.content = `本次运行已中断，未生成最终答案。原因：${displayReason}`;
          currentMsg.content_parts = [{ type: 'text', text: currentMsg.content }];
        }
        if (terminalStatus === 'failed') {
          currentMsg.run_failed = true;
          currentMsg.metadata = {
            ...(currentMsg.metadata || {}),
            terminal_status: 'failed',
            terminal_reason: reason || '未提供失败原因',
            run_failed: true,
          };
          currentMsg.content = `本次运行执行失败：${reason || '未提供失败原因'}`;
          currentMsg.content_parts = [{ type: 'text', text: currentMsg.content }];
        }
        runtime.markRecentSessionUpdated(sessionId, currentMsg);
      }
      if (terminalStatus === 'interrupted' || terminalStatus === 'failed') deps.resetApprovalState?.();
      if (!eventRunId || activeRun.runId === eventRunId) runtime.finalizeActiveRun(sessionId);
      return;
    }

    const eventRunId = event.run_id || null;
    let currentMsg = eventRunId ? findExecutionMessage(eventRunId) : null;
    const lineageParentCallId = event.payload?.lineage?.parent_call_id || null;
    const identityCallIds = [event.call_id, lineageParentCallId].filter(Boolean);
    if (!currentMsg && identityCallIds.length > 0) {
      currentMsg = messages.value.find(message => message?.role === 'assistant'
        && identityCallIds.some(callId => message._execState?.agentsByCallId?.has?.(callId)
          || message._execState?.toolsByCallId?.has?.(callId))) || null;
      if (currentMsg && eventRunId) bindExecutionRun(currentMsg, eventRunId);
    }
    if (!currentMsg && eventRunId && activeRun.active
      && (!activeRun.runId || activeRun.runId === eventRunId)
      && activeRun.assistantMsgIndex >= 0) {
      currentMsg = messages.value[activeRun.assistantMsgIndex] || null;
      if (currentMsg) bindExecutionRun(currentMsg, eventRunId);
    }
    if (!currentMsg && eventRunId && runtime.isDurableReplayActive()
      && typeof lineageParentCallId === 'string' && lineageParentCallId
      && activeRun.assistantMsgIndex >= 0) {
      currentMsg = messages.value[activeRun.assistantMsgIndex] || null;
      if (currentMsg) bindExecutionRun(currentMsg, eventRunId);
    }
    if (!currentMsg && activeRun.assistantMsgIndex >= 0 && !eventRunId) {
      currentMsg = messages.value[activeRun.assistantMsgIndex] || null;
    }
    if (currentMsg) {
      handleRunEvent(event, currentMsg, sessionId);
    }
  };

  return { handleEnvelope, handleRunEvent, resetStreamSessionState, resetInteractionPresentation };
}
