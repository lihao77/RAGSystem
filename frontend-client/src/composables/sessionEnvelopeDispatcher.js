import { nextTick } from 'vue';
import { createSessionEventReducer } from './sessionEventReducer.js';
import { createUserMessage } from './sessionCommandController.js';

const startupPhases = new Set(['creating_session', 'preparing_attachments', 'starting_agent']);

export function createSessionEnvelopeDispatcher({
  deps,
  state,
  runtime,
  recovery,
  interaction,
  taskState,
  getStop,
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
    clearSessionResumeRecovery,
    scheduleCommandFallback,
  } = recovery;
  const {
    mergeExecutionObservability,
    patchTaskInfo,
    refreshSessionExecutionState,
  } = taskState;

  const getEventInteractionId = event => event?.call_id || '';

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
  };

  const handleApprovalRequired = (event, eventData, sessionId) => {
    const approvalData = normalizeApprovalRequiredData(event, eventData);
    if (!interaction.rememberRequired('approval', approvalData.approval_id)) return;
    activeRun.phase = 'approval_waiting';
    deps.enqueueApproval(event, approvalData, sessionId);
  };

  const handleUserInputRequired = (event, eventData) => {
    const inputData = normalizeUserInputRequiredData(event, eventData);
    if (!interaction.rememberRequired('user_input', inputData.input_id)) return;
    const submitUserInput = async (inputId, value) => {
      try {
        await interaction.respond(inputId, { kind: 'user_input', value });
      } catch (error) {
        console.warn('用户输入提交失败:', error);
        deps.showToast(error.message || '用户输入提交失败', 'warning');
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

  const findUserMessageSavedTarget = (eventData) => {
    const requestId = eventData.request_id || null;
    if (requestId) {
      const byRequestId = messages.value.find(
        message => message?.role === 'user' && message.metadata?.request_id === requestId,
      );
      if (byRequestId) return byRequestId;
    }
    const pendingFollowup = messages.value.findLast?.(
      message => message?.role === 'user'
        && message.metadata?.execution_kind === 'session_followup'
        && message.metadata?.persistence_status === 'pending',
    );
    if (pendingFollowup) return pendingFollowup;
    return messages.value[activeRun.assistantMsgIndex - 1] || null;
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
    patchTaskInfo,
    handleApprovalRequired,
    handleUserInputRequired,
  });

  const handleEnvelope = (event, sessionId) => {
    if (sessionId !== currentSessionId.value) return;

    const eventType = event.type;
    const payload = event.payload || {};

    if (eventType === 'heartbeat') return;
    if (activeRun.active || isLoading.value) runtime.observeDeliverySeq(event);

    if (eventType === 'session.reconnect') {
      const phase = payload.phase;
      clearSessionResumeRecovery();
      activeRun.isReplaying = true;
      if (phase === 'start') {
        if (runtime.isDurableOutboxReplayEnvelope(event)) {
          runtime.setDurableReplay({ active: true, runId: event.run_id || null });
          return;
        }
        runtime.setDurableReplay({ active: false });
        if (!isLoading.value) {
          isLoading.value = true;
          const lastMsg = messages.value[messages.value.length - 1];
          if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.finished) {
            messages.value.push(deps.createAssistantMessage());
          }
          activeRun.active = true;
          activeRun.assistantMsgIndex = messages.value.length - 1;
          activeRun.runId = event.run_id || null;
          activeRun.lastSeenSeq = 0;
          if (!activeRun.phase || activeRun.phase === 'idle') {
            activeRun.phase = 'llm_waiting_first_token';
            activeRun.runStartedAt = runtime.eventTimestampSeconds(event);
          }
        }
        if (event.run_id) {
          patchTaskInfo({ run_id: event.run_id, session_id: sessionId, status: 'running' });
        }
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
          patchTaskInfo({ status: 'failed' });
          activeRun.active = false;
          runtime.resetActiveRunRuntime();
          isLoading.value = false;
          return;
        }
        if (activeRun.active && startupPhases.has(activeRun.phase)) {
          activeRun.phase = 'llm_waiting_first_token';
        }
        return;
      }
      if (category === 'stop') return;
      if (category === 'interaction') {
        const refCallId = payload.ref_call_id || '';
        if (payload.ok) {
          if (interaction.hasPending(refCallId)) {
            interaction.resolve(refCallId);
            return;
          }
          if (activeRun.active && activeRun.phase === 'approval_waiting') activeRun.phase = 'tool_running';
          deps.handleApprovalResolved(refCallId, sessionId);
          return;
        }
        if (interaction.hasPending(refCallId)) {
          interaction.reject(refCallId, payload.error || '用户输入提交失败');
          return;
        }
        deps.handleApprovalResolved(refCallId, sessionId);
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
      if (payload.kind === 'approval') {
        if (activeRun.active && activeRun.phase === 'approval_waiting') {
          activeRun.phase = payload.approved === false ? 'llm_waiting_first_token' : 'tool_running';
        }
        deps.handleApprovalResolved(refCallId, sessionId);
      }
      if (interaction.hasPending(refCallId)) interaction.resolve(refCallId);
      return;
    }

    if (eventType === 'run_started') {
      runtime.resetPendingReconciliation();
      const nextRunId = event.run_id || null;
      const shouldStartNewMessage = !activeRun.active
        || (activeRun.runId && nextRunId && activeRun.runId !== nextRunId);
      if (shouldStartNewMessage) {
        const currentMsg = messages.value[activeRun.assistantMsgIndex];
        if (currentMsg && !currentMsg.finished) currentMsg.finished = true;
        if (event.payload?.source === 'system.bg_notification' && event.payload?.task) {
          messages.value.push(createUserMessage(event.payload.task, [], {
            source: 'background_notification',
            request_id: event.payload?.request_id || null,
            run_id: nextRunId,
          }));
        }
        messages.value.push(deps.createAssistantMessage({ run_id: nextRunId }));
        activeRun.active = true;
        activeRun.assistantMsgIndex = messages.value.length - 1;
        activeRun.lastSeenSeq = 0;
        activeRun.isReplaying = runtime.isDurableReplayActive();
        runtime.startActiveRunRuntime(event);
      }
      activeRun.runId = nextRunId;
      if (activeRun.phase === 'idle' || !activeRun.runStartedAt || startupPhases.has(activeRun.phase)) {
        runtime.startActiveRunRuntime(event);
      }
      isLoading.value = true;
      patchTaskInfo({ run_id: nextRunId, session_id: sessionId, status: 'running' });
      refreshSessionExecutionState(sessionId, { silent: true });
      nextTick(() => deps.scrollToBottom(true));
      return;
    }

    if (eventType === 'state_sync') {
      const category = payload.category;
      if (category === 'message_saved') {
        const ref = payload.ref || {};
        const currentMsg = messages.value[activeRun.assistantMsgIndex];
        const target = ref.role === 'user' ? findUserMessageSavedTarget(ref) : currentMsg;
        applyMessageSaved(target, ref, sessionId);
        return;
      }
      if (category === 'session_updated') {
        if (runtime.isRecentlyFinalizedUpdate(event, sessionId)) {
          if (typeof deps.mergeMessageIdsFromServer === 'function') deps.mergeMessageIdsFromServer(sessionId);
          refreshSessionExecutionState(sessionId, { silent: true });
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
        targetMsg.metadata = {
          ...targetMsg.metadata,
          msg_type: 'command_result',
          command: detail.command || 'unknown',
          success: detail.success !== false,
          error: detail.error || null,
          data: detail.data || null,
        };
        targetMsg.finished = true;
        isLoading.value = false;
        deps.deleteMessageCache(sessionId);
        deps.loadSessionMessages(sessionId, { silent: true });
        nextTick(() => deps.scrollToBottom(true));
        return;
      }
    }

    if (eventType === 'run_ended') {
      const terminalStatus = runtime.terminalStatusFromEvent(event);
      const currentMsg = messages.value[activeRun.assistantMsgIndex];
      if (currentMsg) {
        if (terminalStatus === 'interrupted') currentMsg.stopped = true;
        if (terminalStatus === 'failed') currentMsg.run_failed = true;
      }
      if (terminalStatus === 'interrupted' || terminalStatus === 'failed') deps.resetApprovalState?.();
      patchTaskInfo({ thread_alive: false, status: terminalStatus });
      runtime.finalizeActiveRun(sessionId);
      return;
    }

    if (activeRun.active) {
      const currentMsg = messages.value[activeRun.assistantMsgIndex];
      if (currentMsg) {
        mergeExecutionObservability(event);
        handleRunEvent(event, currentMsg, sessionId);
      }
    }
  };

  return { handleEnvelope, handleRunEvent, resetStreamSessionState };
}
