import { ref } from 'vue';
import { canReuseSessionSocket, shouldRefreshSessionMessagesAfterResume } from '../utils/sessionSocket';

/**
 * 会话 WebSocket 连接管理、重连、定时器、activeRun 状态。
 *
 * @param {Object} deps
 * @param {import('vue').Ref} deps.currentSessionId
 * @param {import('vue').Ref} deps.messages
 * @param {import('vue').Ref} deps.isLoading
 * @param {import('vue').Ref} deps.isCompressing
 * @param {import('vue').Reactive} deps.activeRun
 * @param {Function} deps.onMessage - (event, sessionId) => void
 * @param {Function} deps.onRunFinalized - (sessionId) => void
 * @param {Function} deps.resetApprovalState
 * @param {Function} deps.loadSessionMessages
 * @param {Function} deps.deleteMessageCache - (sessionId) => void
 * @param {Function} deps.clearLlmRetryState
 * @param {Function} deps.cacheMessages
 * @param {Function} deps.refreshSessionExecutionState
 * @param {Function} deps.scrollToBottom
 */
export function useSessionConnection(deps) {
  let _ws = null;
  let _wsSessionId = null;
  let _wsReconnectTimer = null;
  let _wsReconnectAttempts = 0;
  let _commandFallbackTimer = null;
  let _sessionResumeRecoveryTimer = null;
  let _sessionResumeRecoveryAbort = null;

  const invalidateActiveStream = () => {
    const { activeRun } = deps;
    activeRun.active = false;
    activeRun.assistantMsgIndex = -1;
    activeRun.runId = null;
    activeRun.lastSeenSeq = 0;
    activeRun.isReplaying = false;
  };

  const scheduleCommandFallback = (sessionId, msgIndex, timeout = 10000) => {
    clearCommandFallback();
    _commandFallbackTimer = setTimeout(() => {
      _commandFallbackTimer = null;
      if (!deps.isLoading.value) return;
      const msg = deps.messages.value[msgIndex];
      if (msg && !msg.finished) {
        msg.content = msg.content || '[命令执行超时或结果未送达]';
        msg.metadata = { ...msg.metadata, type: 'command_result', success: false };
        msg.finished = true;
      }
      deps.activeRun.active = false;
      deps.isLoading.value = false;
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
      if (deps.currentSessionId.value !== sessionId) return;
      if (deps.activeRun.isReplaying || deps.activeRun.lastSeenSeq > 0) return;
      const abort = new AbortController();
      _sessionResumeRecoveryAbort = abort;
      try {
        const resp = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/task-status`, { signal: abort.signal });
        if (!resp.ok || deps.currentSessionId.value !== sessionId) return;
        const result = await resp.json();
        if (result.data?.has_running_task) return;
        if (shouldRefreshSessionMessagesAfterResume({
          hasRunningTask: false,
          activeRun: deps.activeRun.active,
          messages: deps.messages.value,
        })) {
          invalidateActiveStream();
          deps.deleteMessageCache(sessionId);
          await deps.loadSessionMessages(sessionId, { silent: true });
          return;
        }
        await deps.refreshSessionExecutionState(sessionId, { silent: true });
      } catch (_) {
        // 兜底探测失败（含 abort）不影响主流程
      } finally {
        if (_sessionResumeRecoveryAbort === abort) {
          _sessionResumeRecoveryAbort = null;
        }
      }
    }, timeout);
  };

  const finalizeActiveRun = (sessionId) => {
    deps.onRunFinalized(sessionId);
  };

  const connectSessionWS = (sessionId) => {
    if (!sessionId) return;
    if (canReuseSessionSocket(sessionId, _wsSessionId, _ws)) return;
    disconnectSessionWS();
    deps.resetApprovalState();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/api/agent/sessions/${encodeURIComponent(sessionId)}/ws`;
    const ws = new WebSocket(url);
    _wsSessionId = sessionId;
    ws.onopen = () => {
      console.debug('[WS] 连接建立', sessionId);
      _wsReconnectAttempts = 0;
      if (_wsReconnectTimer) {
        clearTimeout(_wsReconnectTimer);
        _wsReconnectTimer = null;
      }
    };
    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        deps.onMessage(event, sessionId);
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
      if (deps.activeRun.active && deps.currentSessionId.value === sessionId) {
        finalizeActiveRun(sessionId);
      }
      clearCommandFallback();
      if (deps.currentSessionId.value === sessionId) {
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

  return {
    invalidateActiveStream,
    scheduleCommandFallback,
    clearCommandFallback,
    clearSessionResumeRecovery,
    scheduleSessionResumeRecovery,
    connectSessionWS,
    disconnectSessionWS,
    getWS,
  };
}
