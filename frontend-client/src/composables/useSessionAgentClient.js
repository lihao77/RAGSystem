import { nextTick } from 'vue';
import { storeToRefs } from 'pinia';
import { getSessionTaskStatus } from '../api/session.js';
import { useSessionRunStore } from '../stores/session-run.js';
import { useRunRuntime } from './useRunRuntime.js';
import { createSessionTransport } from './sessionTransport.js';
import { createSessionInteractionController } from './sessionInteractionController.js';
import { createSessionEventReducer } from './sessionEventReducer.js';
import { createSessionRunRecovery } from './sessionRunRecovery.js';
import { createSessionCommandController, createUserMessage } from './sessionCommandController.js';

export { resetActiveRunForSend, serializeAttachmentForSend } from './sessionCommandController.js';

/**
 * 会话 AgentClient（对标 packages/agent-widget/src/adapter/widget-agent-client.ts 的 WidgetAgentClient）。
 *
 * 单一 client 合并 socket transport + 事件分发 + 运行态 + send/stop + 交互提交 + task 状态写入，
 * 单向数据流（WS → handleEnvelope → store/投影），消除原 composable 互相依赖（widget 架构）。
 * 状态读 session-run store 单源（替代 widget 的 Observable——Vue 场景下 store 已是推模式）。
 *
 * 组成：
 * - WS transport：连接/重连/cursor 去重/delegate 拦截/commandFallback/resumeRecovery 定时器（2.5a）
 * - handleEnvelope：事件分发（原 useSessionRunStream.handleWSMessage），写 store + 调投影（2.5b）
 * - useRunRuntime 组合子：phase/timing/seq gap/durable replay/finalize（client 单向组合）
 * - send/stop：HTTP 降级/followup/附件/task 预查（2.5c）
 * - respondInteraction：统一 approval/user_input WS 提交 + ack + HTTP 降级（2.5d）
 * - task 状态写入：mergeExecutionObservability/refreshSessionExecutionState/beginOptimisticExecutionState（2.5e）
 *
 * @param {Object} deps 业务回调（投影/UI/消息缓存/会话切换/send 单向依赖）
 */
export function useSessionAgentClient(deps) {
  const startupPhases = new Set(['creating_session', 'preparing_attachments', 'starting_agent']);

  const sessionRunStore = useSessionRunStore();
  const {
    currentSessionId,
    messages,
    isLoading,
    isCompressing,
    contextUsage,
    sessionTaskInfo,
    sessionExecutionObservability,
    llmRetryState,
  } = storeToRefs(sessionRunStore);
  const activeRun = sessionRunStore.activeRun;

  // task 状态运行期写入（sessionTaskInfo / sessionExecutionObservability 写 store 单源）；
  // 会话切换的拉取/清理仍留 useSessionTaskStatus，单向调 client.mergeExecutionObservability。
  const mergeExecutionObservability = (payload = {}) => {
    const current = sessionExecutionObservability.value || {};
    sessionExecutionObservability.value = {
      task_id: payload.task_id ?? current.task_id ?? null,
      session_id: payload.session_id ?? current.session_id ?? currentSessionId.value ?? null,
      run_id: payload.run_id ?? current.run_id ?? null,
      execution_kind: payload.execution_kind ?? current.execution_kind ?? null,
      request_id: payload.request_id ?? current.request_id ?? null,
    };
  };
  const refreshSessionExecutionState = async (sessionId) => {
    if (!sessionId) return;
    try {
      const result = await getSessionTaskStatus(sessionId);
      if (currentSessionId.value !== sessionId) return;
      if (result.data?.task_info) {
        sessionTaskInfo.value = result.data.task_info;
      }
      if (result.data?.observability) {
        mergeExecutionObservability(result.data.observability);
      }
    } catch (error) {
      console.warn('refreshSessionExecutionState 状态同步失败:', error.message);
    }
  };
  const beginOptimisticExecutionState = (sessionId) => {
    sessionTaskInfo.value = {
      ...(sessionTaskInfo.value || {}),
      task_id: null,
      session_id: sessionId,
      run_id: null,
      execution_kind: 'agent_stream',
      request_id: null,
      elapsed_seconds: null,
      started_at: null,
      finished_at: null,
      thread_alive: true,
      status: 'running',
    };
    mergeExecutionObservability({
      task_id: null,
      session_id: sessionId,
      run_id: null,
      execution_kind: 'agent_stream',
      request_id: null,
    });
  };

  // run 运行态机（phase/timing/seq gap/durable replay/finalize），状态读 store 单源；
  // 注入 client 内建 refreshSessionExecutionState（第二参数，避免 spread deps 触发 getter TDZ），
  // 使 finalize/durable terminal 的 task 状态同步走 client 单源。
  const runtime = useRunRuntime(deps, { refreshSessionExecutionState });

  const recovery = createSessionRunRecovery({
    getCurrentSessionId: () => currentSessionId.value,
    activeRun,
    messages,
    isLoading,
    deleteMessageCache: deps.deleteMessageCache,
    loadSessionMessages: deps.loadSessionMessages,
    refreshSessionExecutionState,
  });
  const invalidateActiveStream = recovery.invalidateActiveStream;
  const scheduleCommandFallback = recovery.scheduleCommandFallback;
  const clearCommandFallback = recovery.clearCommandFallback;
  const scheduleSessionResumeRecovery = recovery.scheduleSessionResumeRecovery;
  const clearSessionResumeRecovery = recovery.clearSessionResumeRecovery;

  const transport = createSessionTransport({
    getCurrentSessionId: () => currentSessionId.value,
    issueTicket: deps.issueSessionWsTicket,
    onEnvelope: (event, sessionId) => handleEnvelope(event, sessionId),
    onDisconnect: () => {
      clearCommandFallback();
      clearSessionResumeRecovery();
      deps.resetApprovalState();
    },
    onSocketClose: clearCommandFallback,
    onReconnectExhausted: (sessionId) => {
      if (activeRun.active) finalizeActiveRun(sessionId);
    },
  });
  const connectSessionWS = transport.connect;
  const disconnectSessionWS = transport.disconnect;
  const getWS = transport.getSocket;
  const getLastEventSeq = transport.getLastEventSeq;
  const resetSessionEventCursor = transport.resetSessionEventCursor;
  const interactionController = createSessionInteractionController({
    getCurrentSessionId: () => currentSessionId.value,
    getSocket: () => deps.getWS?.() || getWS(),
  });
  const respondInteraction = interactionController.respond;
  const hasPendingInteraction = interactionController.hasPending;
  const resolveInteraction = interactionController.resolve;
  const rejectInteraction = interactionController.reject;

  // ===== 事件分发（原 useSessionRunStream，2.5b 迁入） =====

  const getEventInteractionId = (event) => {
    if (!event || typeof event !== 'object') return '';
    return event.call_id || '';
  };

  const rememberRequiredInteraction = interactionController.rememberRequired;

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
    interactionController.reset();
  };

  const handleApprovalRequired = (event, eventData, sessionId) => {
    const approvalData = normalizeApprovalRequiredData(event, eventData);
    if (!rememberRequiredInteraction('approval', approvalData.approval_id)) return;
    activeRun.phase = 'approval_waiting';
    deps.enqueueApproval(event, approvalData, sessionId);
  };

  const handleUserInputRequired = (event, eventData) => {
    const inputData = normalizeUserInputRequiredData(event, eventData);
    if (!rememberRequiredInteraction('user_input', inputData.input_id)) return;
    const submitUserInput = async (inputId, value) => {
      try {
        await respondInteraction(inputId, { kind: 'user_input', value });
      } catch (e) {
        console.warn('用户输入提交失败:', e);
        deps.showToast(e.message || '用户输入提交失败', 'warning');
        throw e;
      }
    };
    const cancelUserInput = async () => { await stop(); };
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

  // finalize 转发运行态机（run_ended / ack 失败 / 断连放弃重连时调用）
  const finalizeActiveRun = runtime.finalizeActiveRun;

  const handleRunEvent = createSessionEventReducer({
    deps,
    runtime,
    activeRun,
    messages,
    isCompressing,
    contextUsage,
    llmRetryState,
    sessionTaskInfo,
    handleApprovalRequired,
    handleUserInputRequired,
  });

  const handleEnvelope = (event, sessionId) => {
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
        clearCommandFallback();
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
          if (hasPendingInteraction(refCallId)) {
            resolveInteraction(refCallId);
            return;
          }
          if (activeRun.active && activeRun.phase === 'approval_waiting') {
            activeRun.phase = 'tool_running';
          }
          deps.handleApprovalResolved(refCallId, sessionId);
          return;
        }
        // ok=false：先查 user_input pending，否则按 approval 失败处理
        if (hasPendingInteraction(refCallId)) {
          rejectInteraction(refCallId, payload.error || '用户输入提交失败');
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
      if (hasPendingInteraction(refCallId)) {
        resolveInteraction(refCallId);
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

        // 后台通知 system run：前端没乐观 push 这条 user 消息，run_started.task 即其内容
        // （<task-notification>XML）。主动 push 一条（与乐观发送同构），message_saved 再按
        // request_id 落位 id/seq——这样前端实时渲染 background_notification 消息块，不必等刷新。
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
      sessionTaskInfo.value = {
        ...(sessionTaskInfo.value || {}),
        run_id: nextRunId,
        session_id: sessionId,
        status: 'running',
      };
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
          if (typeof deps.mergeMessageIdsFromServer === 'function') {
            deps.mergeMessageIdsFromServer(sessionId);
          }
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
        mergeExecutionObservability(event);
        handleRunEvent(event, currentMsg, sessionId);
      }
    }
  };

  const commandController = createSessionCommandController({
    deps,
    currentSessionId,
    messages,
    isLoading,
    contextUsage,
    sessionTaskInfo,
    activeRun,
    getSocket: () => deps.getWS?.() || getWS(),
    mergeExecutionObservability,
    beginOptimisticExecutionState,
    scheduleCommandFallback,
  });
  const send = commandController.send;
  const stop = commandController.stop;

  return {
    invalidateActiveStream,
    scheduleCommandFallback,
    clearCommandFallback,
    clearSessionResumeRecovery,
    scheduleSessionResumeRecovery,
    connectSessionWS,
    disconnectSessionWS,
    getWS,
    getLastEventSeq,
    resetSessionEventCursor,
    handleEnvelope,
    handleRunEvent,
    finalizeActiveRun,
    resetStreamSessionState,
    send,
    stop,
    respondInteraction,
    mergeExecutionObservability,
    refreshSessionExecutionState,
    beginOptimisticExecutionState,
  };
}
