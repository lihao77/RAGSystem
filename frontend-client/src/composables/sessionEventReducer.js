// @ts-check
/** @typedef {Record<string, any>} AnyRecord */

/** @param {AnyRecord} eventData */
const isVisibleRootCompressionSummary = (eventData) => {
  if (eventData.visible_to_user === false) return false;
  if (eventData.conversation_scope === 'child') return false;
  const threadKey = eventData.thread_key;
  return threadKey == null || threadKey === '' || threadKey === 'root';
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
  /** @param {import('./sessionCoreTypes.js').SessionEnvelope} event @param {import('./sessionCoreTypes.js').SessionMessage} currentMsg @param {string} sessionId */
  return (event, currentMsg, sessionId) => {
    const eventType = event.type;
    const payload = event.payload || {};

    if (
      llmRetryState.value
      && eventType !== 'model_attempt_failed'
      && ['model_request', 'model_attempt_started', 'model_attempt_completed', 'stream_output', 'tool_call', 'tool_result', 'agent_ended', 'error'].includes(eventType)
    ) {
      deps.clearLlmRetryState();
    }

    if (eventType === 'state_sync') {
      const category = payload.category;
      if (category === 'context_usage') {
        const detail = payload.detail || {};
        if (detail.compressing) isCompressing.value = true;
        const ctx = { used: detail.used_tokens, max: detail.budget_tokens };
        if (deps.isRootEvent(event)) {
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
    } else if (eventType === 'model_attempt_started') {
      runtime.markModelAttemptStarted(event);
    } else if (eventType === 'model_attempt_failed') {
      runtime.markModelAttemptFailed(event);
      if (payload.will_retry) {
        deps.setLlmRetryState({
          scope: 'model_attempt',
          nextAttempt: (payload.attempt || 0) + 1,
          maxAttempts: payload.max_attempts || 1,
          waitMs: payload.retry_delay_ms || 0,
          error: payload.error || '',
          provider: payload.provider || '',
          model: payload.model || '',
        });
      } else {
        deps.clearLlmRetryState();
      }
    } else if (eventType === 'model_attempt_completed') {
      runtime.markModelAttemptCompleted(event);
    } else if (eventType === 'stream_output') {
      const phase = payload.phase;
      if (phase === 'first_token') {
        runtime.markLlmFirstToken(event, payload);
      } else if (phase === 'delta') {
        runtime.markOutputChunk(event, payload.content || '');
        if (deps.isMasterEvent(event)) {
          currentMsg.content += payload.content;
        } else {
          deps.applyEnvelopeToMessage(currentMsg, event);
        }
      } else if (phase === 'final') {
        runtime.markModelAttemptCompleted(event);
        if (deps.isMasterEvent(event)) {
          const serverContent = payload.content || '';
          if (serverContent && (!currentMsg.content || currentMsg.content.length < serverContent.length)) {
            currentMsg.content = serverContent;
          }
          currentMsg.finished = true;
          runtime.markRecentSessionUpdated(sessionId, currentMsg);
          deps.cacheMessages(sessionId, messages.value);
          deps.checkSituationScreenTrigger(currentMsg.content);
        } else {
          deps.applyEnvelopeToMessage(currentMsg, event);
        }
      } else if (phase === 'intent_delta' || phase === 'intent_complete') {
        deps.applyEnvelopeToMessage(currentMsg, event);
      }
    } else if (eventType === 'tool_call') {
      deps.applyEnvelopeToMessage(currentMsg, event);
      runtime.markToolStarted(event, payload);
    } else if (eventType === 'tool_result') {
      deps.applyEnvelopeToMessage(currentMsg, event);
      runtime.markToolFinished(event);
    } else if (eventType === 'agent_started') {
      deps.applyEnvelopeToMessage(currentMsg, event);
      if (deps.isMasterEvent(event)) runtime.markRootAgentStarted(event);
    } else if (eventType === 'agent_ended') {
      deps.applyEnvelopeToMessage(currentMsg, event);
      runtime.markAgentFinished(event);
      if (deps.isMasterEvent(event) && !currentMsg.finished) {
        currentMsg.finished = true;
        runtime.markRecentSessionUpdated(sessionId, currentMsg);
        deps.checkSituationScreenTrigger(currentMsg.content);
      }
    } else if (eventType === 'error') {
      currentMsg.status.push({ type: 'error', content: payload.message || '' });
    } else if (eventType === 'interaction' && payload.phase === 'required') {
      if (payload.kind === 'approval') handleApprovalRequired(event, payload, sessionId);
      else if (payload.kind === 'user_input') handleUserInputRequired(event, payload);
    }

    deps.scrollToBottom();
  };
}
