// @ts-check
import {
  buildSessionSocketUrl,
  canReuseSessionSocket,
  getDurableCursorSeq,
  getDurableEventSeq,
} from '../utils/sessionSocket.js';
import { issueSessionWsTicket } from '../api/session.js';
import { getHostTool, getHostToolDeclarations } from '../utils/hostTools.js';

const WS_OPEN = 1;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;

/** @typedef {Record<string, any>} AnyRecord */

/** @param {WebSocket} ws @param {string} sessionId */
const sendHostToolsRegister = (ws, sessionId) => {
  const declarations = getHostToolDeclarations();
  if (!declarations.length || ws.readyState !== WS_OPEN) return;
  ws.send(JSON.stringify({ type: 'tools.register', session_id: sessionId, payload: { tools: declarations } }));
};

/** @param {WebSocket} ws @param {string} sessionId @param {string} callId @param {AnyRecord} payload */
const sendDelegateResult = (ws, sessionId, callId, payload) => {
  if (ws.readyState !== WS_OPEN) return;
  ws.send(JSON.stringify({
    type: 'delegate_result',
    session_id: sessionId,
    call_id: callId,
    payload: { phase: 'result', ...payload },
  }));
};

/** @param {WebSocket} ws @param {AnyRecord} event @param {string} sessionId */
const handleDelegateCall = async (ws, event, sessionId) => {
  const toolName = event.payload?.tool;
  const callId = event.call_id;
  const input = event.payload?.input ?? {};
  const tool = /** @type {any} */ (getHostTool(toolName));
  const startedAt = Date.now();
  if (!tool) {
    sendDelegateResult(ws, sessionId, callId, {
      ok: false,
      error: `前端未注册委托工具: ${toolName}`,
      elapsed_ms: 0,
    });
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
  } catch (error) {
    sendDelegateResult(ws, sessionId, callId, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsed_ms: Date.now() - startedAt,
    });
  }
};

/**
 * @param {{
 *   getCurrentSessionId: () => string | null,
 *   onEnvelope: (event: AnyRecord, sessionId: string) => void,
 *   onDisconnect?: () => void,
 *   onSocketClose?: () => void,
 *   onReconnectExhausted?: (sessionId: string) => void,
 *   issueTicket?: (sessionId: string) => Promise<any>,
 *   createSocket?: (url: string) => WebSocket,
 *   maxReconnectAttempts?: number,
 * }} options
 */
export function createSessionTransport({
  getCurrentSessionId,
  onEnvelope,
  onDisconnect,
  onSocketClose,
  onReconnectExhausted,
  issueTicket = issueSessionWsTicket,
  createSocket = (url) => new WebSocket(url),
  maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
}) {
  /** @type {WebSocket | null} */
  let socket = null;
  /** @type {string | null} */
  let socketSessionId = null;
  /** @type {string | null} */
  let pendingSessionId = null;
  let connectGeneration = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  /** @type {Map<string, number>} */
  const lastEventSeqBySession = new Map();

  /** @param {string} sessionId */
  const getLastEventSeq = (sessionId) => lastEventSeqBySession.get(sessionId) || 0;

  /** @param {string} sessionId */
  const resetSessionEventCursor = (sessionId) => {
    if (sessionId) lastEventSeqBySession.delete(sessionId);
  };

  /** @param {AnyRecord} event @param {string} sessionId */
  const observeDurableCursor = (event, sessionId) => {
    const cursorSeq = getDurableCursorSeq(event);
    if (cursorSeq === null) return getLastEventSeq(sessionId);
    const lastEventSeq = getLastEventSeq(sessionId);
    if (cursorSeq > lastEventSeq) {
      lastEventSeqBySession.set(sessionId, cursorSeq);
      return cursorSeq;
    }
    return lastEventSeq;
  };

  /** @param {AnyRecord} event @param {string} sessionId */
  const shouldDeliverEvent = (event, sessionId) => {
    const eventSeq = getDurableEventSeq(event);
    if (eventSeq !== null) {
      const lastEventSeq = getLastEventSeq(sessionId);
      if (eventSeq <= lastEventSeq) return false;
      lastEventSeqBySession.set(sessionId, eventSeq);
      return true;
    }
    observeDurableCursor(event, sessionId);
    return true;
  };

  /** @param {string} sessionId */
  const scheduleReconnect = (sessionId) => {
    if (getCurrentSessionId() !== sessionId || reconnectTimer) return;
    if (reconnectAttempts >= maxReconnectAttempts) {
      console.warn(`[WS] 达到最大重连次数 (${maxReconnectAttempts})，放弃重连`);
      onReconnectExhausted?.(sessionId);
      return;
    }
    const delay = Math.min(1000 * (2 ** reconnectAttempts), 30000) + Math.random() * 1000;
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect(sessionId, { isReconnect: true });
    }, delay);
  };

  const disconnect = ({ preserveReconnectState = false } = {}) => {
    connectGeneration += 1;
    pendingSessionId = null;
    onDisconnect?.();
    if (!preserveReconnectState) reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const currentSocket = socket;
    socket = null;
    socketSessionId = null;
    currentSocket?.close();
  };

  /** @param {string} sessionId @param {{ isReconnect?: boolean }} [options] */
  const connect = async (sessionId, { isReconnect = false } = {}) => {
    if (!sessionId) return;
    if (canReuseSessionSocket(sessionId, socketSessionId, socket)) return;
    if (pendingSessionId === sessionId) return;
    disconnect({ preserveReconnectState: isReconnect });
    const generation = connectGeneration;
    pendingSessionId = sessionId;
    let ticket;
    try {
      const response = await issueTicket(sessionId);
      ticket = response?.data?.ticket ?? /** @type {any} */ (response)?.ticket;
      if (!ticket) throw new Error('WebSocket ticket 响应无效');
    } catch (error) {
      if (generation === connectGeneration && pendingSessionId === sessionId) {
        pendingSessionId = null;
        console.warn('[WS] ticket 签发失败:', error);
        scheduleReconnect(sessionId);
      }
      return;
    }
    if (generation !== connectGeneration || pendingSessionId !== sessionId || getCurrentSessionId() !== sessionId) return;
    pendingSessionId = null;
    const currentLocation = globalThis.location || { protocol: 'http:', host: '' };
    const lastEventSeq = getLastEventSeq(sessionId);
    const url = buildSessionSocketUrl(sessionId, {
      protocol: currentLocation.protocol,
      host: currentLocation.host,
      afterEventSeq: lastEventSeq > 0 ? lastEventSeq : null,
      ticket,
    });
    const nextSocket = createSocket(url);
    socketSessionId = sessionId;
    nextSocket.onopen = () => {
      console.debug('[WS] 连接建立', sessionId);
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      sendHostToolsRegister(nextSocket, sessionId);
    };
    nextSocket.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (!shouldDeliverEvent(event, sessionId)) return;
        if (event.type === 'delegate_call' && event.payload?.phase === 'request') {
          void handleDelegateCall(nextSocket, event, sessionId);
          return;
        }
        onEnvelope(event, sessionId);
      } catch (error) {
        console.debug('[WS] parse error:', error);
      }
    };
    nextSocket.onclose = () => {
      console.debug('[WS] 连接关闭', sessionId);
      const isCurrentSocket = socket === nextSocket;
      if (isCurrentSocket) {
        socket = null;
        socketSessionId = null;
      }
      if (!isCurrentSocket) return;
      onSocketClose?.();
      if (getCurrentSessionId() === sessionId) scheduleReconnect(sessionId);
    };
    nextSocket.onerror = () => {};
    socket = nextSocket;
  };

  return {
    connect,
    disconnect,
    getSocket: () => socket,
    getLastEventSeq,
    resetSessionEventCursor,
  };
}
