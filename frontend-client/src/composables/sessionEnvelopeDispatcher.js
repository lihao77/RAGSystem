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
  finishPendingCommand,
  reorderMessages,
  onRuntimeSnapshot,
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
    scheduleCommandFallback,
  } = recovery;
  const presentedInteractions = new Map();
  const pendingBoundaryEvents = new Map();
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
    pendingBoundaryEvents.clear();
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
    // 用户输入由聊天区的 ChatInteractionHost 统一承载，不能回退到旧的浮层弹窗。
    deps.showUserInput?.(inputData, submitUserInput, cancelUserInput);
  };

  /** @param {AnyRecord} eventData */
  const findUserMessageSavedTarget = (eventData) => {
    const requestId = eventData.request_id || null;
    if (!requestId) return null;
    return messages.value.find(
      /** @param {AnyRecord} message */
      message => message?.role === 'user' && message.metadata?.request_id === requestId,
    ) || null;
  };

  /** @param {AnyRecord[]} parts */
  const getCanonicalUserContent = (parts) => parts.flatMap((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return [part.text];
    if (part?.type === 'command_ref' && typeof part.raw_text === 'string') return [part.raw_text];
    return [];
  }).join('');

  /** @param {string | null | undefined} requestId */
  const finishRequest = (requestId) => {
    if (requestId) finishPendingCommand(requestId);
  };

  /** @param {import('./sessionCoreTypes.js').SessionMessage} message */
  const getMessageRunId = message => message?.run_id
    || message?.metadata?.consumed_by_run_id
    || message?.metadata?.run_id
    || null;

  /** @param {import('./sessionCoreTypes.js').SessionMessage | null | undefined} message */
  const getMessageExecutionRunIds = message => Array.isArray(message?.metadata?.execution_run_ids)
    ? message.metadata.execution_run_ids.filter(value => typeof value === 'string' && value)
    : [];

  /** @param {string | null | undefined} runId */
  const findExecutionMessage = runId => {
    if (!runId) return null;
    const matches = messages.value.filter(message => (
      (message?.role === 'assistant' || message?.role === 'user')
        && (getMessageRunId(message) === runId || getMessageExecutionRunIds(message).includes(runId))
    ));
    // A Run's final answer is always the assistant message. The user message
    // is its execution boundary and must remain immutable when run_ended
    // arrives after the canonical user message event.
    return matches.find(message => message?.role === 'assistant') || matches[0] || null;
  };

  /** @param {import('./sessionCoreTypes.js').SessionMessage} message @param {string} runId */
  const bindExecutionRun = (message, runId) => {
    const runIds = new Set(getMessageExecutionRunIds(message));
    runIds.add(runId);
    message.metadata = { ...(message.metadata || {}), execution_run_ids: [...runIds] };
  };

  /** @param {import('./sessionCoreTypes.js').SessionMessage} message @param {string | null | undefined} runId @returns {import('./sessionCoreTypes.js').SessionMessage} */
  const insertNewRunUserMessage = (message, runId) => {
    let assistantIndex = messages.value.findIndex(
      item => item?.role === 'assistant' && getMessageRunId(item) === runId,
    );
    if (assistantIndex < 0 && activeRun.assistantMsgIndex >= 0) {
      const activeAssistant = messages.value[activeRun.assistantMsgIndex];
      if (activeAssistant?.role === 'assistant' && activeAssistant.finished !== true) {
        assistantIndex = activeRun.assistantMsgIndex;
      }
    }
    if (assistantIndex < 0) {
      messages.value.push(message);
      return message;
    }
    messages.value.splice(assistantIndex, 0, message);
    if (activeRun.assistantMsgIndex >= assistantIndex) activeRun.assistantMsgIndex += 1;
    return message;
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
      ...(eventData.metadata && typeof eventData.metadata === 'object' ? eventData.metadata : {}),
      ...(eventData.request_id ? { request_id: eventData.request_id } : {}),
      ...(eventData.run_id ? { run_id: eventData.run_id } : {}),
      ...(eventData.task_id ? { task_id: eventData.task_id } : {}),
      ...(eventData.consumed_by_run_id ? { consumed_by_run_id: eventData.consumed_by_run_id } : {}),
      ...(eventData.mailbox_message_id ? { mailbox_message_id: eventData.mailbox_message_id } : {}),
    };
    if (target.role === 'user'
      && (target.run_id || target.metadata?.run_id || target.metadata?.consumed_by_run_id)) {
      target.has_execution = true;
    } else {
      target.has_execution = false;
    }
    if (target.role === 'user') target.finished = true;
    if (Number.isSafeInteger(target.seq)) reorderMessages();
    deps.cacheMessages(sessionId, messages.value);
  };

  /** Mailbox user messages become visible only after the consumer persists them. */
  /** @param {import('./sessionCoreTypes.js').SessionEnvelope} event @param {string} sessionId */
  const handleConsumedUserMessage = (event, sessionId) => {
    const payload = event.payload || {};
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    const isConsumedUserMessage = Boolean(metadata.mailbox_message_id)
      && metadata.agent_message !== true
      && metadata.visible_to_user !== false;
    if (!isConsumedUserMessage) return false;
    const eventData = {
      ...metadata,
      message_id: payload.message_id || event.message_id || null,
      seq: payload.seq,
      role: 'user',
      request_id: metadata.request_id || payload.request_id || null,
      run_id: metadata.consumed_by_run_id || event.run_id || null,
      task_id: metadata.task_id || null,
      round_index: metadata.round_index,
      content_parts: payload.content_parts,
      metadata,
    };
    const requestId = eventData.request_id;
    let target = requestId
      ? messages.value.find(message => message?.role === 'user' && message.metadata?.request_id === requestId) || null
      : null;
    if (!target && eventData.message_id) {
      target = messages.value.find(message => message?.role === 'user' && message.id === eventData.message_id) || null;
    }
    if (!target) {
      const parts = normalizeMessageContentParts(payload.content_parts);
      const content = getCanonicalUserContent(parts);
      const message = createUserMessage(content, [], {
        ...metadata,
        request_id: requestId,
        run_id: eventData.run_id,
        ...(metadata.source ? { source: metadata.source } : {}),
        ...(metadata.consumed_by_run_id ? { consumed_by_run_id: metadata.consumed_by_run_id } : {}),
      });
      insertNewRunUserMessage(message, eventData.run_id);
      target = message;
    }
    applyMessageSaved(target, eventData, sessionId);
    flushBoundaryEvents(eventData.run_id);
    finishRequest(requestId);
    deps.updateRecentSession(sessionId, target.content, new Date().toISOString());
    return true;
  };

  /** Execution is displayed under the latest conversation boundary before the assistant carrier. */
  /** @param {import('./sessionCoreTypes.js').SessionMessage} carrier @param {string | null | undefined} runId */
  const findExecutionBoundaryMessage = (carrier, runId) => {
    const boundaryMessageId = carrier?.__boundaryMessageId || null;
    if (boundaryMessageId) {
      const explicit = messages.value.find(message => message?.role === 'user' && message.id === boundaryMessageId);
      if (explicit) return explicit;
    }
    const carrierIndex = messages.value.indexOf(carrier);
    const endIndex = carrierIndex >= 0 ? carrierIndex : messages.value.length;
    for (let index = endIndex - 1; index >= 0; index -= 1) {
      const message = messages.value[index];
      if (message?.role !== 'user') continue;
      const messageRunId = getMessageRunId(message);
      // Child Runs share the parent conversation boundary. An explicit
      // boundary_message_id is preferred; otherwise the nearest real user
      // message before the carrier is authoritative even when its run_id is
      // the parent/root Run rather than the child Run.
      if (runId && messageRunId && messageRunId !== runId && carrier?.role === 'user') continue;
      if (runId && !messageRunId) {
        const isPendingRunBoundary = message.metadata?.execution_kind === 'agent_stream'
          || message.metadata?.execution_kind === 'session_followup'
          || message.metadata?.source === 'running_session';
        if (!isPendingRunBoundary) continue;
        message.run_id = runId;
        message.metadata = { ...(message.metadata || {}), run_id: runId };
      }
      message.finished = true;
      message.has_execution = true;
      return message;
    }
    return carrier?.role === 'user' ? carrier : null;
  };

  /** @param {string | null | undefined} runId */
  const flushBoundaryEvents = (runId) => {
    if (!runId) return;
    const pending = pendingBoundaryEvents.get(runId);
    if (!pending?.length) return;
    const boundary = findExecutionBoundaryMessage(null, runId);
    if (!boundary) return;
    pendingBoundaryEvents.delete(runId);
    for (const event of pending) deps.applyEnvelopeToMessage(boundary, event);
  };

  /** @param {import('./sessionCoreTypes.js').SessionMessage} carrier @param {import('./sessionCoreTypes.js').SessionEnvelope} event */
  const applyEnvelopeToBoundaryMessage = (carrier, event) => {
    const boundary = event?.boundary_message_id
      ? messages.value.find(message => message?.role === 'user' && message.id === event.boundary_message_id)
      : findExecutionBoundaryMessage(carrier, event.run_id || getMessageRunId(carrier));
    if (boundary) {
      deps.applyEnvelopeToMessage(boundary, event);
      return;
    }
    const runId = event?.run_id || getMessageRunId(carrier);
    if (runId) {
      const pending = pendingBoundaryEvents.get(runId) || [];
      pending.push(event);
      pendingBoundaryEvents.set(runId, pending);
    }
  };

  const eventReducerDeps = Object.create(deps);
  Object.defineProperty(eventReducerDeps, 'applyEnvelopeToMessage', {
    value: applyEnvelopeToBoundaryMessage,
  });

  const handleRunEvent = createSessionEventReducer({
    deps: eventReducerDeps,
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
    const boundary = messages.value.find(message => message?.role === 'user'
      && getMessageRunId(message) === runId);
    let assistantMsgIndex = messages.value.findIndex(message => message?.role === 'assistant'
      && (message?.run_id === runId || message?.metadata?.run_id === runId)
      && message.finished !== true);
    if (assistantMsgIndex < 0 && boundary) {
      const nextAssistant = messages.value.findIndex(message => message?.role === 'assistant'
        && !message.finished && messages.value.indexOf(message) > messages.value.indexOf(boundary));
      if (nextAssistant >= 0) assistantMsgIndex = nextAssistant;
    }
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

    if (eventType === 'agent_message' && handleConsumedUserMessage(event, sessionId)) {
      nextTick(() => deps.scrollToBottom(true));
      return;
    }
    if (eventType === 'agent_message') {
      nextTick(() => deps.scrollToBottom(true));
      return;
    }

    if (eventType === 'ack') {
      const category = payload.category;
      if (category === 'send') {
        clearCommandFallback();
        if (!payload.ok) {
          finishRequest(payload.request_id);
          deps.showToast(payload.error || '启动执行失败');
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
      let currentAssistantIndex = activeRun.assistantMsgIndex;
      let currentMsg = messages.value[currentAssistantIndex];
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
      const canReuseCurrentAssistant = currentMsg?.role === 'assistant'
        && !currentMsg.finished
        && (!activeRun.runId || !nextRunId || activeRun.runId === nextRunId)
        && (!currentMsgRunId || !nextRunId || currentMsgRunId === nextRunId);
      const shouldStartNewMessage = !canReuseCurrentAssistant;
      if (shouldStartNewMessage) {
        if (currentMsg && !currentMsg.finished) currentMsg.finished = true;
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
        let target = ref.role === 'user'
            ? findUserMessageSavedTarget(ref)
            : matchingAssistant || (refRunId && getMessageRunId(currentMsg) === refRunId ? currentMsg : null);
        if (!target && ref.role === 'user' && refMessageId) {
          target = messages.value.find(message => message?.role === 'user' && message.id === refMessageId) || null;
        }
        if (!target && ref.role === 'user' && Array.isArray(ref.content_parts)) {
          const contentParts = normalizeMessageContentParts(ref.content_parts);
          const content = getCanonicalUserContent(contentParts);
          target = createUserMessage(content, getMessageAttachments({ content_parts: contentParts }), {
            ...(ref.metadata && typeof ref.metadata === 'object' ? ref.metadata : {}),
            ...(ref.request_id ? { request_id: ref.request_id } : {}),
            ...(refRunId ? { run_id: refRunId } : {}),
          });
          target.content_parts = contentParts;
          insertNewRunUserMessage(target, refRunId);
        }
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
            has_execution: false,
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
        if (ref.role === 'user') {
          finishRequest(ref.request_id);
          if (target) deps.updateRecentSession(sessionId, target.content, new Date().toISOString());
          flushBoundaryEvents(refRunId || getMessageRunId(target));
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
          scheduleCommandFallback(sessionId, 120000);
          return;
        }
        clearCommandFallback();
        if (detail.request_id) finishRequest(detail.request_id);
        else finishPendingCommand();
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
      if (eventRunId && targetRootRunId && eventRunId !== targetRootRunId
        && !currentMsg?._execState?.agentsByCallId?.has?.(event.call_id)) {
        return;
      }
      const terminalStatus = runtime.terminalStatusFromEvent(event);
      if (terminalStatus === 'suspended') return;
      if (currentMsg) {
        currentMsg.finished = true;
        currentMsg.has_execution = currentMsg.role === 'user';
        if (eventRunId) {
          currentMsg.run_id = eventRunId;
          currentMsg.metadata = { ...(currentMsg.metadata || {}), run_id: eventRunId };
        }
        const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
        // User messages own the execution tree but never own terminal answer
        // text. A terminal assistant message is persisted by the backend and
        // will arrive through its canonical message_saved event.
        if (currentMsg.role !== 'user' && terminalStatus === 'interrupted') {
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
        if (currentMsg.role !== 'user' && terminalStatus === 'failed') {
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
      currentMsg = messages.value.find(message => (message?.role === 'assistant' || message?.role === 'user')
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
    } else if (eventRunId) {
      // Runtime phase still follows durable events while the canonical user
      // boundary is being loaded. The detached carrier is never inserted or
      // used for rendering; execution projection remains queued above.
      handleRunEvent(event, {
        role: 'assistant',
        content: '',
        content_parts: [],
        finished: false,
        status: [],
        metadata: {},
        executionTree: { root: null, steps: [] },
      }, sessionId);
    }
  };

  return { handleEnvelope, handleRunEvent, resetStreamSessionState, resetInteractionPresentation };
}
