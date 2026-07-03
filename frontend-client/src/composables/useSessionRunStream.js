import { nextTick } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';
import { useUserInputSubmission } from './useUserInputSubmission.js';
import { useRunRuntime } from './useRunRuntime.js';

/**
 * 会话流式事件路由与 run 生命周期管理。
 *
 * 只负责消费 WS 事件、推进 activeRun/message 状态，
 * 不负责 socket 连接建立本身，也不改动视图模板结构。
 */
export function useSessionRunStream(deps) {
  const startupPhases = new Set(['creating_session', 'preparing_attachments', 'starting_agent']);

  const sessionRunStore = useSessionRunStore();
  const {
    messages,
    currentSessionId,
    isLoading,
    isCompressing,
    contextUsage,
    sessionTaskInfo,
    llmRetryState,
  } = storeToRefs(sessionRunStore);
  const activeRun = sessionRunStore.activeRun;
  const userInput = useUserInputSubmission({ getWS: () => deps.getWS?.() });

  // 交互去重：避免同一 approval/user_input required 事件重复入队
  const _handledRequiredInteractions = new Set();

  // run 运行态机（phase/timing/seq gap/durable replay/finalize），状态读 store 单源
  const runtime = useRunRuntime(deps);

  const isVisibleRootCompressionSummary = (eventData) => {
    if (eventData.visible_to_user === false) return false;
    if (eventData.conversation_scope === 'child') return false;
    const threadKey = eventData.thread_key;
    if (threadKey != null && threadKey !== '' && threadKey !== 'root') return false;
    return true;
  };

  const getEventInteractionId = (event) => {
    if (!event || typeof event !== 'object') return '';
    return event.call_id || '';
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
    // 后端 user_input payload.input={input_type,options,extra,...}；展开到顶层供 WorkPanelUserInput 读取。
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
    _handledRequiredInteractions.clear();
    userInput.reset();
  };

  const handleApprovalRequired = (event, eventData, sessionId) => {
    const approvalData = normalizeApprovalRequiredData(event, eventData);
    if (!rememberRequiredInteraction('approval', approvalData.approval_id)) return;
    activeRun.phase = 'approval_waiting';
    deps.enqueueApproval(event, approvalData, sessionId);
  };

  const handleUserInputRequired = (event, eventData, sessionId) => {
    const inputData = normalizeUserInputRequiredData(event, eventData);
    if (!rememberRequiredInteraction('user_input', inputData.input_id)) return;
    const submitUserInput = async (inputId, value) => {
      try {
        await userInput.submitForSession(sessionId, inputId, value);
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
      const byRequestId = messages.value.find(
        msg => msg?.role === 'user' && msg.metadata?.request_id === requestId
      );
      if (byRequestId) return byRequestId;
    }
    const pendingFollowup = messages.value.findLast?.(
      msg => msg?.role === 'user'
        && msg.metadata?.execution_kind === 'session_followup'
        && msg.metadata?.persistence_status === 'pending'
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
    if (target.metadata.persistence_status) {
      delete target.metadata.persistence_status;
    }
    deps.cacheMessages(sessionId, messages.value);
  };

  // finalize 转发运行态机（run_ended / ack 失败时调用）
  const finalizeActiveRun = runtime.finalizeActiveRun;

  const handleRunEvent = (event, currentMsg, sessionId) => {
    const eventType = event.type;
    const payload = event.payload || {};

    // LLM 重试清除：流恢复信号（非 retry state_sync）到达即清
    if (
      llmRetryState.value
      && eventType !== 'state_sync'
      && (
        eventType === 'stream_output'
        || eventType === 'tool_call'
        || eventType === 'tool_result'
        || eventType === 'agent_ended'
        || eventType === 'error'
      )
    ) {
      deps.clearLlmRetryState();
    }

    if (eventType === 'state_sync') {
      const category = payload.category;
      if (category === 'retry') {
        const detail = payload.detail || {};
        const waitMs = Number.isFinite(detail.wait_ms) ? detail.wait_ms : Math.round((detail.wait_seconds || 0) * 1000);
        deps.setLlmRetryState({
          scope: detail.scope || 'chat_completion_stream',
          nextAttempt: detail.next_attempt || ((detail.failed_attempt || 0) + 1),
          maxAttempts: detail.max_attempts || 1,
          waitMs,
          error: detail.error || '',
          provider: detail.provider || '',
          model: detail.model || '',
        });
        activeRun.phase = 'retrying';
        sessionTaskInfo.value = { ...(sessionTaskInfo.value || {}), status: 'running' };
      } else if (category === 'waiting') {
        const detail = payload.detail || {};
        const isStart = detail.phase === 'start' || Boolean(detail.wait_id && !activeRun.waiting);
        if (deps.isMasterEvent(event)) {
          if (isStart) runtime.markWaitingStart(event, detail);
          else runtime.markWaitingFinished(detail);
        }
      } else if (category === 'reflection') {
        if (deps.isMasterEvent(event)) activeRun.phase = 'reflecting';
      } else if (category === 'context_usage') {
        const detail = payload.detail || {};
        if (detail.compressing) isCompressing.value = true;
        const agentId = event.agent_id;
        const ctx = { used: detail.used_tokens, max: detail.budget_tokens };
        if (deps.isRootEvent(event)) {
          contextUsage.value = ctx;
        } else {
          const agent = deps.findRunningExecutionAgentByAgentId(currentMsg.executionTree, agentId);
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
              m => m.metadata?.compression && m.content === summaryContent
            );
            if (!alreadyExists) {
              const compressionMsg = {
                role: 'system',
                content: summaryContent,
                metadata: {
                  compression: true,
                  ...(detail.thread_key != null ? { thread_key: detail.thread_key } : {}),
                  ...(detail.conversation_scope != null ? { conversation_scope: detail.conversation_scope } : {}),
                  ...(detail.visible_to_user != null ? { visible_to_user: detail.visible_to_user } : {}),
                  ...(detail.child_agent_id != null ? { child_agent_id: detail.child_agent_id } : {}),
                  ...(detail.run_id != null ? { run_id: detail.run_id } : {}),
                },
              };
              messages.value.splice(activeRun.assistantMsgIndex, 0, compressionMsg);
              activeRun.assistantMsgIndex++;
            }
          }
        }
      }
    } else if (eventType === 'stream_output') {
      const phase = payload.phase;
      if (phase === 'first_token') {
        if (deps.isMasterEvent(event)) runtime.markLlmFirstToken(event, payload);
      } else if (phase === 'delta') {
        if (deps.isMasterEvent(event)) {
          currentMsg.content += payload.content;
          runtime.markOutputChunk(event, payload.content || '');
        } else {
          // 子 agent 流式输出 → core applyOutputStream 累加到 agent.output
          deps.applyEnvelopeToMessage(currentMsg, event);
        }
      } else if (phase === 'final') {
        if (deps.isMasterEvent(event)) {
          // content 补偿：若 delta 累积不完整，用 final 的完整内容覆盖
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
      if (deps.isMasterEvent(event)) activeRun.phase = 'tool_running';
    } else if (eventType === 'tool_result') {
      deps.applyEnvelopeToMessage(currentMsg, event);
      if (deps.isMasterEvent(event) && activeRun.phase !== 'background_waiting') {
        activeRun.phase = 'llm_waiting_first_token';
      }
    } else if (eventType === 'agent_started') {
      deps.applyEnvelopeToMessage(currentMsg, event);
    } else if (eventType === 'agent_ended') {
      deps.applyEnvelopeToMessage(currentMsg, event);
      if (deps.isMasterEvent(event) && !currentMsg.finished) {
        currentMsg.finished = true;
        markRecentSessionUpdated(sessionId, currentMsg);
        deps.checkSituationScreenTrigger(currentMsg.content);
      }
    } else if (eventType === 'error') {
      currentMsg.status.push({ type: 'error', content: payload.message || '' });
    } else if (eventType === 'interaction' && payload.phase === 'required') {
      if (payload.kind === 'approval') {
        handleApprovalRequired(event, payload, sessionId);
      } else if (payload.kind === 'user_input') {
        handleUserInputRequired(event, payload, sessionId);
      }
    }

    deps.scrollToBottom();
  };

  const handleWSMessage = (event, sessionId) => {
    if (sessionId !== currentSessionId.value) return;

    const eventType = event.type;
    const payload = event.payload || {};

    if (eventType === 'heartbeat') return;

    // 统一推进投递序号（内部对无效 seq 自动跳过）
    if (activeRun.active || isLoading.value) {
      runtime.observeDeliverySeq(event);
    }

    if (eventType === 'session.reconnect') {
      const phase = payload.phase;
      deps.clearSessionResumeRecovery();
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
          sessionTaskInfo.value = {
            ...(sessionTaskInfo.value || {}),
            run_id: event.run_id,
            session_id: sessionId,
            status: 'running',
          };
        }
        return;
      }
      // phase === 'end'
      if (runtime.isDurableOutboxReplayEnvelope(event)) {
        runtime.setDurableReplay({ active: false });
      }
      activeRun.isReplaying = false;
      return;
    }

    if (runtime.handleInactiveDurableReplayEvent(event, sessionId)) return;

    if (eventType === 'ack') {
      const category = payload.category;
      if (category === 'send') {
        deps.clearCommandFallback();
        if (!payload.ok) {
          const currentMsg = messages.value[activeRun.assistantMsgIndex];
          if (currentMsg) {
            currentMsg.content = `\n\n[System Error: ${payload.error || '启动执行失败'}]`;
            currentMsg.finished = true;
          }
          sessionTaskInfo.value = { ...(sessionTaskInfo.value || {}), status: 'failed' };
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
      if (category === 'stop') {
        return;
      }
      if (category === 'interaction') {
        const refCallId = payload.ref_call_id || '';
        if (payload.ok) {
          if (userInput.hasPending(refCallId)) {
            userInput.resolveSubmission(refCallId);
            return;
          }
          if (activeRun.active && activeRun.phase === 'approval_waiting') {
            activeRun.phase = 'tool_running';
          }
          deps.handleApprovalResolved(refCallId, sessionId);
          return;
        }
        // ok=false：先查 user_input pending，否则按 approval 失败处理
        if (userInput.hasPending(refCallId)) {
          userInput.rejectSubmission(refCallId, payload.error || '用户输入提交失败');
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
      if (currentMsg) {
        currentMsg.status.push({ type: 'error', content: payload.message || '' });
      }
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
      // user_input responded：兜底 resolve pending（主路径由 ack(interaction) 确认）
      if (userInput.hasPending(refCallId)) {
        userInput.resolveSubmission(refCallId);
      }
      return;
    }

    if (eventType === 'run_started') {
      runtime.resetPendingReconciliation(); // 新 run 重置 gap 标记
      const nextRunId = event.run_id || null;
      const shouldStartNewMessage = !activeRun.active || (activeRun.runId && nextRunId && activeRun.runId !== nextRunId);
      if (shouldStartNewMessage) {
        const currentMsg = messages.value[activeRun.assistantMsgIndex];
        if (currentMsg && !currentMsg.finished) {
          currentMsg.finished = true;
        }

        const hasNotificationMsg = messages.value.some(
          msg => msg.role === 'user' && msg.metadata?.source === 'system.bg_notification' && msg._bgRunId === nextRunId
        );
        if (!hasNotificationMsg) {
          messages.value.push(deps.buildTaskNotificationMessage(sessionId, event));
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
      sessionTaskInfo.value = {
        ...(sessionTaskInfo.value || {}),
        run_id: nextRunId,
        session_id: sessionId,
        status: 'running',
      };
      deps.refreshSessionExecutionState(sessionId, { silent: true });
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
          if (typeof deps.mergeMessageIdsFromServer === 'function') {
            deps.mergeMessageIdsFromServer(sessionId);
          }
          deps.refreshSessionExecutionState(sessionId, { silent: true });
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
          deps.scheduleCommandFallback(sessionId, activeRun.assistantMsgIndex, 120000);
          return;
        }
        deps.clearCommandFallback();
        let targetIndex = messages.value.length - 1;
        let targetMsg = messages.value[targetIndex];
        if (!targetMsg || targetMsg.role !== 'assistant' || targetMsg.finished) {
          messages.value.push(deps.createAssistantMessage());
          targetIndex = messages.value.length - 1;
          targetMsg = messages.value[targetIndex];
        }
        targetMsg.content = detail.content || '';
        targetMsg.metadata = {
          ...targetMsg.metadata,
          type: 'command_result',
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
      // 其余 category（context_usage/compression/retry/waiting/reflection）转 handleRunEvent
    }

    if (eventType === 'run_ended') {
      const terminalStatus = runtime.terminalStatusFromEvent(event);
      const currentMsg = messages.value[activeRun.assistantMsgIndex];
      if (currentMsg) {
        // 打断确认：run 真正以 interrupted 终止时才显示"已停止生成"tag
        if (terminalStatus === 'interrupted') currentMsg.stopped = true;
        // run 真正以 failed 终止时标记，wpr-label 据此显示"执行异常"（工具失败不等于 run 异常）
        if (terminalStatus === 'failed') currentMsg.run_failed = true;
      }
      // run 非正常终止时，pending approval/input 已失效——后端 abort 只 reject
      // waitForApproval/waitForUserInput 但不发取消事件，前端 approvalQueue 会残留导致弹窗不消失。
      // 据权威终态信号清空 approvalQueue + pendingUserInput，关闭残留弹窗。
      if (terminalStatus === 'interrupted' || terminalStatus === 'failed') {
        deps.resetApprovalState?.();
      }
      sessionTaskInfo.value = {
        ...(sessionTaskInfo.value || {}),
        thread_alive: false,
        status: terminalStatus,
      };
      finalizeActiveRun(sessionId);
      return;
    }

    if (activeRun.active) {
      const currentMsg = messages.value[activeRun.assistantMsgIndex];
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
    resetStreamSessionState,
  };
}
