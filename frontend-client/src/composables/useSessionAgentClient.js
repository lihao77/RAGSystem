import { nextTick, ref } from 'vue';
import { storeToRefs } from 'pinia';
import {
  buildSessionSocketUrl,
  canReuseSessionSocket,
  getDurableCursorSeq,
  getDurableEventSeq,
  shouldRefreshSessionMessagesAfterResume,
} from '../utils/sessionSocket.js';
import { resetActiveRunState } from '../stores/session-run.js';
import { getHostTool, getHostToolDeclarations } from '../utils/hostTools.js';
import { createAssistantMessage } from './useMessageExecution.js';
import { getSessionTaskStatus, startStream, stopStream, respondInteraction as respondInteractionApi } from '../api/session.js';
import { useSessionRunStore } from '../stores/session-run.js';
import { useRunRuntime } from './useRunRuntime.js';

const WS_OPEN = 1;

const isOpenWebSocket = (ws) => !!ws && ws.readyState === WS_OPEN;

/** 交互提交 ack 等待超时（WS 主路径，超时抛错不降级）。 */
const INTERACTION_ACK_TIMEOUT_MS = 8000;
const INTERACTION_ACK_TIMEOUT_CODE = 'INTERACTION_ACK_TIMEOUT';
const INTERACTION_REJECTED_CODE = 'INTERACTION_REJECTED';

/** 握手期注册前端委托工具清单（后端据此判定工具归属 + 委托回前端执行）。 */
const sendHostToolsRegister = (ws, sessionId) => {
  const declarations = getHostToolDeclarations();
  if (!declarations.length || ws.readyState !== WS_OPEN) return;
  ws.send(JSON.stringify({ type: 'tools.register', session_id: sessionId, payload: { tools: declarations } }));
};

/** 回传委托执行结果（delegate_result, phase=result）。 */
const sendDelegateResult = (ws, sessionId, callId, payload) => {
  if (ws.readyState !== WS_OPEN) return;
  ws.send(JSON.stringify({ type: 'delegate_result', session_id: sessionId, call_id: callId, payload: { phase: 'result', ...payload } }));
};

/** 委托执行请求：路由 hostTool.execute + 回传 delegate_result（不进投影展示，对用户透明）。 */
const handleDelegateCall = async (ws, event, sessionId) => {
  const toolName = event.payload?.tool;
  const callId = event.call_id;
  const input = event.payload?.input ?? {};
  const tool = getHostTool(toolName);
  const startedAt = Date.now();
  if (!tool) {
    sendDelegateResult(ws, sessionId, callId, { ok: false, error: `前端未注册委托工具: ${toolName}`, elapsed_ms: 0 });
    return;
  }
  try {
    const result = await tool.execute(input, { callId, sessionId, runId: event.run_id ?? null });
    sendDelegateResult(ws, sessionId, callId, {
      ok: result.ok !== false,
      observation: typeof result.observation === 'string' ? result.observation : '',
      ...(result.error ? { error: result.error } : {}),
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    sendDelegateResult(ws, sessionId, callId, {
      ok: false,
      error: err?.message || String(err),
      elapsed_ms: Date.now() - startedAt,
    });
  }
};

// ===== send/stop 工具（原 useSessionSend，2.5c 迁入） =====

const resetActiveRunForSend = (activeRun, assistantMsgIndex) => {
  activeRun.active = true;
  activeRun.assistantMsgIndex = assistantMsgIndex;
  activeRun.runId = null;
  activeRun.lastSeenSeq = 0;
  activeRun.isReplaying = false;
  activeRun.phase = 'llm_waiting_first_token';
  activeRun.runStartedAt = Date.now() / 1000;
  activeRun.firstTokenAt = null;
  activeRun.firstTokenLatencyMs = null;
  activeRun.latestLlmFirstTokenAt = null;
  activeRun.lastChunkAt = null;
  activeRun.waiting = null;
  activeRun.outputCharCount = 0;
};

const resetActiveRunAfterSendError = (activeRun) => {
  activeRun.active = false;
  activeRun.phase = 'idle';
  activeRun.waiting = null;
  activeRun.runStartedAt = null;
  activeRun.firstTokenAt = null;
  activeRun.firstTokenLatencyMs = null;
  activeRun.latestLlmFirstTokenAt = null;
  activeRun.lastChunkAt = null;
  activeRun.outputCharCount = 0;
};

const serializeAttachmentForSend = ({ file_id, original_name, stored_name, mime, size, kind }) => ({
  file_id,
  original_name,
  stored_name,
  mime,
  size,
  kind,
});

const createRequestId = () => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const buildUserMetadata = (attachments, metadata = {}) => ({
  ...(attachments.length ? { attachments } : {}),
  ...metadata,
});

const createUserMessage = (content, attachments, metadata = {}) => ({
  role: 'user',
  content,
  attachments,
  metadata: buildUserMetadata(attachments, metadata),
});

const createAgentStreamMetadata = (requestId) => ({
  request_id: requestId,
  execution_kind: 'agent_stream',
});

const createFollowupMetadata = (requestId, activeRun, fallbackRunId = null) => ({
  request_id: requestId,
  execution_kind: 'session_followup',
  source: 'running_session',
  persistence_status: 'pending',
  ...(activeRun.runId || fallbackRunId ? { run_id: activeRun.runId || fallbackRunId } : {}),
});

/**
 * 会话 AgentClient（对标 packages/agent-widget/src/adapter/widget-agent-client.ts 的 WidgetAgentClient）。
 *
 * 合并 socket transport + 事件分发（handleEnvelope）+ 运行态 + send/stop + respondInteraction，
 * 单向数据流（WS → handleEnvelope → store/投影），消除 composable 互相依赖；
 * 状态读 session-run store 单源（替代 widget 的 Observable）。
 *
 * 进度：
 * - 2.5a WS transport（连接/重连/cursor/delegate 拦截/定时器/getWS）
 * - 2.5b 事件分发 handleEnvelope（原 useSessionRunStream.handleWSMessage）+ 运行态（useRunRuntime）迁入
 * - 2.5c send/stop、2.5d respondInteraction、2.5e task 状态写入 待迁
 *
 * @param {Object} deps 业务回调（投影/UI/消息缓存/task 状态/send/stop 等单向依赖）
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
  // 注入 client 内建 refreshSessionExecutionState，使 finalize/durable terminal 的 task 状态同步走 client 单源。
  const runtime = useRunRuntime({ ...deps, refreshSessionExecutionState });

  // 交互提交（统一 approval/user_input 的 WS 主路径 + ack pending + HTTP 降级），对标 widget
  // WidgetAgentClient.respondInteraction；frontend-client 保留 HTTP 降级（WS 不通兜底）。
  const _pendingInteractions = new Map(); // callId -> { resolve, reject, timer }
  const clearInteractionPending = (callId) => {
    const pending = _pendingInteractions.get(callId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    _pendingInteractions.delete(callId);
    return pending;
  };
  const hasPendingInteraction = (callId) => _pendingInteractions.has(callId);
  const resolveInteraction = (callId) => {
    const pending = clearInteractionPending(callId);
    if (!pending) return false;
    pending.resolve();
    return true;
  };
  const rejectInteraction = (callId, errMsg) => {
    const pending = clearInteractionPending(callId);
    if (!pending) return false;
    const error = new Error(errMsg || '交互提交失败');
    error.code = INTERACTION_REJECTED_CODE;
    pending.reject(error);
    return true;
  };
  const buildInteractionPayload = (response) => {
    if (response.kind === 'user_input') {
      return { kind: 'user_input', phase: 'responded', value: String(response.value ?? '') };
    }
    return { kind: 'approval', phase: 'responded', approved: !!response.approved, message: response.message };
  };
  const submitInteractionWs = (ws, sessionId, callId, payload) => new Promise((resolve, reject) => {
    if (!callId) {
      reject(new Error('交互请求缺少 call_id'));
      return;
    }
    const existing = clearInteractionPending(callId);
    if (existing) existing.reject(new Error('交互已重新提交'));
    const timer = setTimeout(() => {
      _pendingInteractions.delete(callId);
      const error = new Error('交互提交确认超时');
      error.code = INTERACTION_ACK_TIMEOUT_CODE;
      reject(error);
    }, INTERACTION_ACK_TIMEOUT_MS);
    _pendingInteractions.set(callId, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ type: 'interaction', session_id: sessionId, call_id: callId, payload }));
    } catch (error) {
      clearInteractionPending(callId);
      reject(error);
    }
  });
  const respondInteractionHttp = async (sessionId, interactionId, response) => {
    if (response.kind === 'user_input') {
      await respondInteractionApi(sessionId, interactionId, { kind: 'user_input', value: String(response.value ?? '') });
      return;
    }
    await respondInteractionApi(sessionId, interactionId, { kind: 'approval', approved: !!response.approved, message: response.message });
  };
  /**
   * 响应交互（approval / user_input）：WS 主路径（带 ack 等待），失败降级 HTTP；
   * ack 超时/被拒不降级（抛错让 UI 反馈）。对标 widget WidgetAgentClient.respondInteraction。
   */
  const respondInteraction = async (interactionId, response) => {
    const sessionId = currentSessionId.value;
    const payload = buildInteractionPayload(response);
    const ws = deps.getWS?.() || getWS();
    if (isOpenWebSocket(ws)) {
      try {
        await submitInteractionWs(ws, sessionId, interactionId, payload);
        return;
      } catch (error) {
        if (error?.code === INTERACTION_ACK_TIMEOUT_CODE || error?.code === INTERACTION_REJECTED_CODE) {
          throw error;
        }
        console.warn('交互 WS 提交失败，降级 HTTP:', error);
      }
    }
    await respondInteractionHttp(sessionId, interactionId, response);
  };
  // 交互去重：避免同一 approval/user_input required 事件重复入队
  const _handledRequiredInteractions = new Set();

  let _ws = null;
  let _wsSessionId = null;
  let _wsReconnectTimer = null;
  const MAX_RECONNECT_ATTEMPTS = 10;
  let _wsReconnectAttempts = 0;
  let _commandFallbackTimer = null;
  let _sessionResumeRecoveryTimer = null;
  let _sessionResumeRecoveryAbort = null;
  const _lastEventSeqBySession = new Map();

  const invalidateActiveStream = () => {
    resetActiveRunState(activeRun);
  };

  const scheduleCommandFallback = (sessionId, msgIndex, timeout = 10000) => {
    clearCommandFallback();
    _commandFallbackTimer = setTimeout(() => {
      _commandFallbackTimer = null;
      if (!isLoading.value) return;
      const msg = messages.value[msgIndex];
      if (msg && !msg.finished) {
        msg.content = msg.content || '[命令执行超时或结果未送达]';
        msg.metadata = { ...msg.metadata, type: 'command_result', success: false };
        msg.finished = true;
      }
      resetActiveRunState(activeRun);
      isLoading.value = false;
      deps.deleteMessageCache(sessionId);
      deps.loadSessionMessages(sessionId, { silent: true });
    }, timeout);
  };

  const clearCommandFallback = () => {
    if (_commandFallbackTimer) {
      clearTimeout(_commandFallbackTimer);
      _commandFallbackTimer = null;
    }
  };

  const clearSessionResumeRecovery = () => {
    if (_sessionResumeRecoveryTimer) {
      clearTimeout(_sessionResumeRecoveryTimer);
      _sessionResumeRecoveryTimer = null;
    }
    if (_sessionResumeRecoveryAbort) {
      _sessionResumeRecoveryAbort.abort();
      _sessionResumeRecoveryAbort = null;
    }
  };

  const scheduleSessionResumeRecovery = (sessionId, timeout = 1500) => {
    clearSessionResumeRecovery();
    _sessionResumeRecoveryTimer = window.setTimeout(async () => {
      _sessionResumeRecoveryTimer = null;
      if (currentSessionId.value !== sessionId) return;
      if (activeRun.isReplaying || activeRun.lastSeenSeq > 0) return;
      const abort = new AbortController();
      _sessionResumeRecoveryAbort = abort;
      try {
        const result = await getSessionTaskStatus(sessionId, { signal: abort.signal });
        if (currentSessionId.value !== sessionId) return;
        if (result.data?.has_running_task) return;
        if (shouldRefreshSessionMessagesAfterResume({
          hasRunningTask: false,
          activeRun: activeRun.active,
          messages: messages.value,
        })) {
          invalidateActiveStream();
          deps.deleteMessageCache(sessionId);
          await deps.loadSessionMessages(sessionId, { silent: true });
          return;
        }
        await refreshSessionExecutionState(sessionId, { silent: true });
      } catch (error) {
        // 兜底探测失败（含 abort）不影响主流程，留痕便于排查
        console.warn('resume task-status 探测失败:', error.message);
        return;
      } finally {
        if (_sessionResumeRecoveryAbort === abort) {
          _sessionResumeRecoveryAbort = null;
        }
      }
    }, timeout);
  };

  const getLastEventSeq = (sessionId) => _lastEventSeqBySession.get(sessionId) || 0;
  const resetSessionEventCursor = (sessionId) => {
    if (!sessionId) return;
    _lastEventSeqBySession.delete(sessionId);
  };

  const observeDurableCursor = (event, sessionId) => {
    const cursorSeq = getDurableCursorSeq(event);
    if (cursorSeq === null) return getLastEventSeq(sessionId);
    const lastEventSeq = getLastEventSeq(sessionId);
    if (cursorSeq > lastEventSeq) {
      _lastEventSeqBySession.set(sessionId, cursorSeq);
      return cursorSeq;
    }
    return lastEventSeq;
  };

  const shouldDeliverEvent = (event, sessionId) => {
    const eventSeq = getDurableEventSeq(event);
    if (eventSeq !== null) {
      const lastEventSeq = getLastEventSeq(sessionId);
      if (eventSeq <= lastEventSeq) return false;
      _lastEventSeqBySession.set(sessionId, eventSeq);
      return true;
    }
    observeDurableCursor(event, sessionId);
    return true;
  };

  const connectSessionWS = (sessionId) => {
    if (!sessionId) return;
    if (canReuseSessionSocket(sessionId, _wsSessionId, _ws)) return;
    disconnectSessionWS();
    deps.resetApprovalState();
    const currentLocation = globalThis.location || { protocol: 'http:', host: '' };
    const lastEventSeq = getLastEventSeq(sessionId);
    const url = buildSessionSocketUrl(sessionId, {
      protocol: currentLocation.protocol,
      host: currentLocation.host,
      afterEventSeq: lastEventSeq > 0 ? lastEventSeq : null,
    });
    const ws = new WebSocket(url);
    _wsSessionId = sessionId;
    ws.onopen = () => {
      console.debug('[WS] 连接建立', sessionId);
      _wsReconnectAttempts = 0;
      if (_wsReconnectTimer) {
        clearTimeout(_wsReconnectTimer);
        _wsReconnectTimer = null;
      }
      // 握手期注册前端委托工具清单（后端据此判定工具归属 + 委托回前端执行）
      sendHostToolsRegister(ws, sessionId);
    };
    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (!shouldDeliverEvent(event, sessionId)) return;
        // 委托执行请求：拦截路由 hostTool.execute + 回传 delegate_result（不进投影展示）
        if (event.type === 'delegate_call' && event.payload?.phase === 'request') {
          handleDelegateCall(ws, event, sessionId);
          return;
        }
        handleEnvelope(event, sessionId);
      } catch (err) {
        console.debug('[WS] parse error:', err);
      }
    };
    ws.onclose = () => {
      console.debug('[WS] 连接关闭', sessionId);
      const isCurrentSocket = _ws === ws;
      if (isCurrentSocket) {
        _ws = null;
        _wsSessionId = null;
      }
      if (!isCurrentSocket) return;
      // 断连时不立即 finalize——先尝试重连，由恢复兜底逻辑决定是否 finalize
      clearCommandFallback();
      if (currentSessionId.value === sessionId) {
        if (_wsReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          console.warn(`[WS] 达到最大重连次数 (${MAX_RECONNECT_ATTEMPTS})，放弃重连`);
          if (activeRun.active) {
            finalizeActiveRun(sessionId);
          }
          return;
        }
        const delay = Math.min(1000 * Math.pow(2, _wsReconnectAttempts), 30000) + Math.random() * 1000;
        _wsReconnectAttempts++;
        _wsReconnectTimer = setTimeout(() => connectSessionWS(sessionId), delay);
      }
    };
    ws.onerror = () => {};
    _ws = ws;
  };

  const disconnectSessionWS = () => {
    clearCommandFallback();
    clearSessionResumeRecovery();
    deps.resetApprovalState();
    _wsReconnectAttempts = 0;
    if (_wsReconnectTimer) {
      clearTimeout(_wsReconnectTimer);
      _wsReconnectTimer = null;
    }
    const ws = _ws;
    _ws = null;
    _wsSessionId = null;
    if (ws) ws.close();
  };

  /** 获取当前 WS 实例（用于直接发送消息） */
  const getWS = () => _ws;

  // ===== 事件分发（原 useSessionRunStream，2.5b 迁入） =====

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
    for (const pending of _pendingInteractions.values()) {
      clearTimeout(pending.timer);
      pending.reject?.(new Error('会话已切换，交互提交已取消'));
    }
    _pendingInteractions.clear();
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
        runtime.markRecentSessionUpdated(sessionId, currentMsg);
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
        mergeExecutionObservability(event);
        handleRunEvent(event, currentMsg, sessionId);
      }
    }
  };

  // ===== send/stop（原 useSessionSend，2.5c 迁入） =====
  const lastFailedSendContent = ref('');

  const stop = async () => {
    if (!currentSessionId.value) return;
    const ws = deps.getWS?.() || getWS();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'abort', session_id: currentSessionId.value, payload: { scope: 'run' } }));
    } else {
      try {
        await stopStream(currentSessionId.value);
      } catch (error) {
        console.warn('停止请求发送失败:', error);
      }
    }
    sessionTaskInfo.value = {
      ...(sessionTaskInfo.value || {}),
      status: 'cancel_requested',
    };
    // 不在此处乐观结束 run / 显示"已停止"tag：等 WS 回传 run.end(interrupted) 确认打断成功后再显示
  };

  const send = async (payload = null) => {
    const content = (payload?.content ?? deps.inputMessage.value).trim();
    const draftAttachments = Array.isArray(payload?.attachments)
      ? payload.attachments.slice()
      : deps.pendingAttachments.value.slice();
    const replaceFromIndex = Number.isInteger(payload?.replaceFromIndex) ? payload.replaceFromIndex : null;
    const clearEditing = payload?.clearEditing === true;
    let isRunningFollowup = Boolean(
      currentSessionId.value
      && activeRun.active
      && replaceFromIndex == null
    );
    if ((!content && !draftAttachments.length) || (isLoading.value && !isRunningFollowup)) return;
    if (isRunningFollowup && draftAttachments.length) {
      deps.showToast('运行中补充暂不支持附件', 'warning');
      return;
    }

    const startsDraftSession = !currentSessionId.value && replaceFromIndex == null;
    const requestId = createRequestId();
    let userMetadata = isRunningFollowup
      ? createFollowupMetadata(requestId, activeRun)
      : createAgentStreamMetadata(requestId);
    let sessionId = currentSessionId.value;
    let assistantMsgIndex = -1;
    let userMsgIndex = -1;
    let attachments = draftAttachments;
    let followupMsgIndex = -1;

    if (startsDraftSession) {
      userMsgIndex = messages.value.push(createUserMessage(content, draftAttachments, userMetadata)) - 1;
      deps.inputMessage.value = '';
      deps.clearComposerAttachments();
      deps.stickToBottom();

      assistantMsgIndex = messages.value.push(createAssistantMessage()) - 1;
      resetActiveRunForSend(activeRun, assistantMsgIndex);
      activeRun.phase = 'creating_session';
      isLoading.value = true;
      contextUsage.value = { used: 0, max: 0 };
    }

    try {
      sessionId = await deps.ensureSession({ replaceRoute: startsDraftSession });
    } catch (error) {
      console.error('Error creating session:', error);
      if (startsDraftSession) {
        const currentMsg = messages.value[assistantMsgIndex];
        if (currentMsg) {
          currentMsg.content += `\n\n[System Error: ${error.message || '创建会话失败'}]`;
          currentMsg.finished = true;
        }
        resetActiveRunAfterSendError(activeRun);
        isLoading.value = false;
      }
      deps.showToast('会话创建失败');
      return;
    }

    if (startsDraftSession && activeRun.active) {
      activeRun.phase = draftAttachments.length ? 'preparing_attachments' : 'starting_agent';
    }

    try {
      const result = await getSessionTaskStatus(sessionId);
      sessionTaskInfo.value = result.data?.task_info || null;
      if (result.data?.observability) {
        mergeExecutionObservability(result.data.observability);
      }
      if (result.data?.has_running_task && !isRunningFollowup) {
        if (sessionId && replaceFromIndex == null && !startsDraftSession) {
          isRunningFollowup = true;
          userMetadata = createFollowupMetadata(requestId, activeRun, result.data?.task_info?.run_id || null);
        } else {
          deps.showToast('该会话正在执行任务，请等待完成或先停止', 'warning');
          if (startsDraftSession) {
            const currentMsg = messages.value[assistantMsgIndex];
            if (currentMsg) {
              currentMsg.content += '\n\n[System Error: 该会话正在执行任务，请等待完成或先停止]';
              currentMsg.finished = true;
            }
            resetActiveRunAfterSendError(activeRun);
            isLoading.value = false;
          }
          return;
        }
      }
    } catch (error) {
      console.warn('发送前查询任务状态失败:', error.message);
    }

    try {
      attachments = isRunningFollowup
        ? []
        : await deps.materializeAttachmentsForSend(draftAttachments, sessionId);
    } catch (error) {
      if (startsDraftSession) {
        const currentMsg = messages.value[assistantMsgIndex];
        if (currentMsg) {
          currentMsg.content += `\n\n[System Error: ${error.message || '附件准备失败'}]`;
          currentMsg.finished = true;
        }
        resetActiveRunAfterSendError(activeRun);
        isLoading.value = false;
      }
      deps.showToast(error.message || '附件准备失败');
      return;
    }

    if (startsDraftSession && activeRun.active) {
      activeRun.phase = 'starting_agent';
    }

    if (replaceFromIndex != null) {
      messages.value = messages.value.slice(0, replaceFromIndex);
      deps.cacheMessages(sessionId, messages.value);
      if (clearEditing) {
        deps.resetEditingState({ closeDrawer: false });
        deps.clearEditingAttachments();
      }
    }

    if (startsDraftSession) {
      const userMsg = messages.value[userMsgIndex];
      if (userMsg) {
        userMsg.attachments = attachments;
        userMsg.metadata = buildUserMetadata(attachments, userMetadata);
      }
      deps.cacheMessages(sessionId, messages.value);
    } else if (isRunningFollowup) {
      const followupMsg = createUserMessage(content, [], userMetadata);
      const insertIndex = activeRun.assistantMsgIndex >= 0
        ? Math.min(activeRun.assistantMsgIndex, messages.value.length)
        : messages.value.length;
      messages.value.splice(insertIndex, 0, followupMsg);
      followupMsgIndex = insertIndex;
      if (activeRun.assistantMsgIndex >= insertIndex) {
        activeRun.assistantMsgIndex += 1;
      }
      deps.inputMessage.value = '';
      deps.clearComposerAttachments();
      deps.cacheMessages(sessionId, messages.value);
      deps.stickToBottom();
    } else {
      messages.value.push(createUserMessage(content, attachments, userMetadata));
      deps.inputMessage.value = '';
      deps.clearComposerAttachments();
      deps.stickToBottom();
    }
    deps.updateRecentSession(sessionId, content, new Date().toISOString());

    if (!startsDraftSession && !isRunningFollowup) {
      assistantMsgIndex = messages.value.push(createAssistantMessage()) - 1;
      resetActiveRunForSend(activeRun, assistantMsgIndex);
    }

    if (!isRunningFollowup) {
      beginOptimisticExecutionState(sessionId);
    }
    if (!startsDraftSession && !isRunningFollowup) {
      isLoading.value = true;
      contextUsage.value = { used: 0, max: 0 };
    }

    try {
      const body = {
        task: content,
        session_id: sessionId,
        use_v2: true,
        attachments: attachments.map(serializeAttachmentForSend),
      };
      const selectedLlm = deps.getCurrentSelectedLlm();
      if (selectedLlm) {
        body.selected_llm = selectedLlm;
      }

      const ws = deps.getWS?.() || getWS();
      if (ws?.readyState === WebSocket.OPEN) {
        // 通过 WS 发送，ack 结果由 handleEnvelope 中的 ack(category=send) 处理
        ws.send(JSON.stringify({
          type: 'user_driven_change',
          session_id: sessionId,
          payload: {
            category: 'task_submit',
            task: body.task,
            attachments: body.attachments,
            ...(body.selected_llm ? { selected_llm: body.selected_llm } : {}),
            request_id: requestId,
          },
        }));
        if (!isRunningFollowup) {
          scheduleCommandFallback(sessionId, assistantMsgIndex, 30000);
        }
        return;
      }

      const streamResp = await startStream(body, requestId);
      const result = streamResp.data || {};

      if (!result.started) {
        const errorMsg = result.error || '启动执行失败';
        if (result.kind === 'command') {
          scheduleCommandFallback(sessionId, assistantMsgIndex);
          return;
        }
        throw new Error(errorMsg);
      }

      if (result.run_id) {
        activeRun.runId = result.run_id;
      }
      if (!isRunningFollowup) {
        activeRun.phase = 'llm_waiting_first_token';
      }

      if (result.kind === 'command') {
        scheduleCommandFallback(sessionId, assistantMsgIndex, 60000);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      if (isRunningFollowup) {
        const followupMsg = messages.value[followupMsgIndex];
        if (followupMsg) {
          followupMsg.status = [
            ...(followupMsg.status || []),
            { type: 'error', content: error.message || '补充说明发送失败' },
          ];
          followupMsg.metadata = {
            ...(followupMsg.metadata || {}),
            persistence_status: 'failed',
          };
        }
      } else {
        const currentMsg = messages.value[assistantMsgIndex];
        if (currentMsg) {
          currentMsg.content += `\n\n[System Error: ${error.message || 'Request failed'}]`;
          currentMsg.finished = true;
        }
        sessionTaskInfo.value = { ...(sessionTaskInfo.value || {}), status: 'failed' };
        resetActiveRunAfterSendError(activeRun);
        isLoading.value = false;
      }
      deps.showToast('消息发送失败', async () => {
        if (lastFailedSendContent.value) {
          deps.inputMessage.value = lastFailedSendContent.value;
          await nextTick();
          send();
        }
      });
    }
  };

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
