import { ref } from 'vue';
import {
  buildSessionSocketUrl,
  canReuseSessionSocket,
  getDurableCursorSeq,
  getDurableEventSeq,
  shouldRefreshSessionMessagesAfterResume,
} from '../utils/sessionSocket.js';
import { resetActiveRunState } from './useActiveRunState.js';
import { getHostTool, getHostToolDeclarations } from '../utils/hostTools.js';

const WS_OPEN = 1;

/** 握手期注册前端委托工具清单（后端据此判定工具归属 + 委托回前端执行）。 */
const sendHostToolsRegister = (ws, sessionId) => {
  const declarations = getHostToolDeclarations();
  if (!declarations.length || ws.readyState !== WS_OPEN) return;
  ws.send(JSON.stringify({ type: 'tools.register', session_id: sessionId, payload: { tools: declarations } }));
};

/** 回传委托执行结果（mode=delegation, phase=result）。 */
const sendDelegatedToolResult = (ws, sessionId, callId, payload) => {
  if (ws.readyState !== WS_OPEN) return;
  ws.send(JSON.stringify({ type: 'tool_result', session_id: sessionId, call_id: callId, payload: { mode: 'delegation', phase: 'result', ...payload } }));
};

/** 委托工具执行请求：路由 hostTool.execute + 回传 tool_result（不进投影展示，对用户透明）。 */
const handleDelegatedToolCall = async (ws, event, sessionId) => {
  const toolName = event.payload?.tool;
  const callId = event.call_id;
  const input = event.payload?.input ?? {};
  const tool = getHostTool(toolName);
  const startedAt = Date.now();
  if (!tool) {
    sendDelegatedToolResult(ws, sessionId, callId, { ok: false, error: `前端未注册委托工具: ${toolName}`, elapsed_ms: 0 });
    return;
  }
  try {
    const result = await tool.execute(input, { callId, sessionId, runId: event.run_id ?? null });
    sendDelegatedToolResult(ws, sessionId, callId, {
      ok: result.ok !== false,
      observation: typeof result.observation === 'string' ? result.observation : '',
      ...(result.error ? { error: result.error } : {}),
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    sendDelegatedToolResult(ws, sessionId, callId, {
      ok: false,
      error: err?.message || String(err),
      elapsed_ms: Date.now() - startedAt,
    });
  }
};

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
  const MAX_RECONNECT_ATTEMPTS = 10;
  let _wsReconnectAttempts = 0;
  let _commandFallbackTimer = null;
  let _sessionResumeRecoveryTimer = null;
  let _sessionResumeRecoveryAbort = null;
  const _lastEventSeqBySession = new Map();

  const invalidateActiveStream = () => {
    resetActiveRunState(deps.activeRun);
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
      resetActiveRunState(deps.activeRun);
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
        // 委托工具执行请求：拦截路由 hostTool.execute + 回传 tool_result（不进投影展示）
        if (event.type === 'tool_call' && event.payload?.mode === 'delegation' && event.payload?.phase === 'request') {
          handleDelegatedToolCall(ws, event, sessionId);
          return;
        }
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
      // 断连时不立即 finalize——先尝试重连，由恢复兜底逻辑决定是否 finalize
      clearCommandFallback();
      if (deps.currentSessionId.value === sessionId) {
        if (_wsReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          console.warn(`[WS] 达到最大重连次数 (${MAX_RECONNECT_ATTEMPTS})，放弃重连`);
          if (deps.activeRun.active) {
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
  };
}
