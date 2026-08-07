// @ts-check

/** @typedef {Record<string, any>} AnyRecord */

/** @param {AnyRecord} eventData */
const isVisibleRootCompressionSummary = (eventData) => {
  if (eventData.visible_to_user === false) return false;
  if (eventData.conversation_scope === 'child') return false;
  const threadKey = eventData.thread_key;
  return threadKey == null || threadKey === '' || threadKey === 'root';
};

/** @param {AnyRecord} model */
const retryStateForModel = (model) => {
  const parsedRetryAt = model.retry_at ? Date.parse(model.retry_at) : Number.NaN;
  const fallbackWaitMs = Number(model.retry_delay_ms);
  const waitMs = Number.isFinite(parsedRetryAt)
    ? Math.max(0, parsedRetryAt - Date.now())
    : Number.isFinite(fallbackWaitMs) ? Math.max(0, fallbackWaitMs) : 0;
  return {
    scope: 'model_attempt',
    callId: model.call_id,
    agentId: model.agent_id || '',
    nextAttempt: (model.attempt || 0) + 1,
    maxAttempts: model.max_attempts || 1,
    waitMs,
    nextRetryAt: Number.isFinite(parsedRetryAt) ? parsedRetryAt : Date.now() + waitMs,
    error: model.error || '',
    provider: model.provider || '',
    model: model.model || '',
  };
};

/** @param {import('./sessionCoreTypes.js').EventReducerOptions} options */
export function createSessionEventReducer({
  deps,
  runtime,
  activeRun,
  messages,
  isCompressing,
  contextUsage,
  llmRetryState,
  handleApprovalRequired,
  handleUserInputRequired,
}) {
  const syncLlmRetryState = () => {
    const retryModels = Object.values(activeRun.runningModelCalls || {}).filter(
      model => model.status === 'retry_wait',
    );
    const current = llmRetryState.value;
    const selected = retryModels.find(
      model => model.call_id === current?.callId && (model.agent_id || '') === (current?.agentId || ''),
    ) || retryModels[0];
    if (selected) {
      deps.setLlmRetryState(retryStateForModel(selected));
    } else if (current) {
      deps.clearLlmRetryState();
    }
  };

  /** @param {import('./sessionCoreTypes.js').SessionEnvelope} event @param {import('./sessionCoreTypes.js').SessionMessage} currentMsg @param {string} sessionId */
  return (event, currentMsg, sessionId) => {
    const eventType = event.type;
    const payload = event.payload || {};

    if (eventType === 'state_sync') {
      const category = payload.category;
      if (category === 'context_usage') {
        const detail = payload.detail || {};
        if (detail.compressing) isCompressing.value = true;
        const isRoot = deps.isRootEvent(event);
        // Estimates are internal compression telemetry. The user-facing value only
        // changes after a provider has reported this round's real input and output.
        if (detail.token_source !== 'provider') return;
        if (!Number.isFinite(detail.used_tokens) || !Number.isFinite(detail.budget_tokens)) return;
        const ctx = {
          used: detail.used_tokens,
          max: detail.budget_tokens,
          source: 'provider',
          providerUsed: detail.used_tokens,
        };
        if (isRoot) {
          contextUsage.value = ctx;
        } else {
          const agent = deps.findRunningExecutionAgentByAgentId(currentMsg.executionTree, event.agent_id);
          if (agent) agent.ctx = ctx;
        }
      } else if (category === 'compression') {
        const detail = payload.detail || {};
        const isSummary = detail.type === 'compression_summary' || Boolean(detail.content);
        if (!isSummary) {
          isCompressing.value = true;
        } else {
          isCompressing.value = false;
          if (isVisibleRootCompressionSummary(detail)) {
            const summaryContent = detail.content || '';
            const alreadyExists = messages.value.some(
              /** @param {AnyRecord} message */
              message => message.metadata?.msg_type === 'context_compression_summary'
                && message.content === summaryContent,
            );
            if (!alreadyExists) {
              messages.value.splice(activeRun.assistantMsgIndex, 0, {
                role: 'system',
                content: summaryContent,
                metadata: {
                  msg_type: 'context_compression_summary',
                  ...(detail.thread_key != null ? { thread_key: detail.thread_key } : {}),
                  ...(detail.conversation_scope != null ? { conversation_scope: detail.conversation_scope } : {}),
                  ...(detail.visible_to_user != null ? { visible_to_user: detail.visible_to_user } : {}),
                  ...(detail.child_agent_id != null ? { child_agent_id: detail.child_agent_id } : {}),
                  ...(detail.run_id != null ? { run_id: detail.run_id } : {}),
                },
              });
              activeRun.assistantMsgIndex += 1;
            }
          }
        }
      }
    } else if (eventType === 'model_request') {
      runtime.markModelRequestStarted(event, deps.isMasterEvent(event));
      syncLlmRetryState();
    } else if (eventType === 'model_attempt_started') {
      runtime.markModelAttemptStarted(event);
      syncLlmRetryState();
    } else if (eventType === 'model_attempt_failed') {
      runtime.markModelAttemptFailed(event);
      syncLlmRetryState();
    } else if (eventType === 'model_attempt_completed') {
      runtime.markModelAttemptCompleted(event);
      syncLlmRetryState();
    } else if (eventType === 'stream_output') {
      const phase = payload.phase;
      if (phase === 'first_token') {
        runtime.markLlmFirstToken(event, payload);
        syncLlmRetryState();
      } else if (phase === 'delta') {
        runtime.markOutputChunk(event, payload.content || '');
        syncLlmRetryState();
        if (deps.isMasterEvent(event)) {
          currentMsg.content += payload.content;
        } else {
          deps.applyEnvelopeToMessage(currentMsg, event);
        }
      } else if (phase === 'final') {
        runtime.markModelAttemptCompleted(event);
        syncLlmRetryState();
        if (deps.isMasterEvent(event)) {
          const serverContent = payload.content || '';
          if (serverContent && (!currentMsg.content || currentMsg.content.length < serverContent.length)) {
            currentMsg.content = serverContent;
          }
          currentMsg.finished = true;
          runtime.markRecentSessionUpdated(sessionId, currentMsg);
          deps.cacheMessages(sessionId, messages.value);
        } else {
          deps.applyEnvelopeToMessage(currentMsg, event);
        }
      } else if (phase === 'intent_delta' || phase === 'intent_complete') {
        runtime.markModelStreaming(event);
        syncLlmRetryState();
        deps.applyEnvelopeToMessage(currentMsg, event);
      }
    } else if (eventType === 'tool_call') {
      deps.applyEnvelopeToMessage(currentMsg, event);
      runtime.markToolStarted(event, payload);
      syncLlmRetryState();
    } else if (eventType === 'tool_result') {
      deps.applyEnvelopeToMessage(currentMsg, event);
      runtime.markToolFinished(event);
      syncLlmRetryState();
    } else if (eventType === 'agent_started') {
      deps.applyEnvelopeToMessage(currentMsg, event);
      if (deps.isMasterEvent(event)) runtime.markRootAgentStarted(event);
    } else if (eventType === 'agent_ended') {
      deps.applyEnvelopeToMessage(currentMsg, event);
      runtime.markAgentFinished(event);
      syncLlmRetryState();
      if (deps.isMasterEvent(event) && !currentMsg.finished) {
        currentMsg.finished = true;
        runtime.markRecentSessionUpdated(sessionId, currentMsg);
      }
    } else if (eventType === 'error') {
      runtime.markModelAttemptCompleted(event);
      syncLlmRetryState();
      currentMsg.status.push({ type: 'error', content: payload.message || '' });
    } else if (eventType === 'interaction' && payload.phase === 'required') {
      if (payload.kind === 'approval') handleApprovalRequired(event, payload, sessionId);
      else if (payload.kind === 'user_input') handleUserInputRequired(event, payload);
    }

    deps.scrollToBottom();
  };
}
