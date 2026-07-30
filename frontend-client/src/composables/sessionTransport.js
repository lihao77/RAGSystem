// @ts-check
import { EnvelopeDeliveryCursor } from '@ragsystem/agent-protocol/wire';
import {
  buildSessionSocketUrl,
  canReuseSessionSocket,
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

/** @param {import('./sessionCoreTypes.js').SessionTransportOptions} options */
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
  /** 首次历史快照回放尚未完成时，自动重连必须继续请求 active run 展示。 */
  /** @type {string | null} */
  let historySnapshotPendingSessionId = null;
  /** @type {Map<string, EnvelopeDeliveryCursor>} */
  const deliveryCursors = new Map();

  /** @param {string} sessionId */
  const getDeliveryCursor = (sessionId) => {
    const current = deliveryCursors.get(sessionId);
    if (current) return current;
    const created = new EnvelopeDeliveryCursor();
    deliveryCursors.set(sessionId, created);
    return created;
  };

  /** @param {string} sessionId */
  const getLastEventSeq = (sessionId) => deliveryCursors.get(sessionId)?.lastSeq || 0;

  /** @param {string} sessionId @param {number} afterEventSeq */
  const initializeSessionEventCursor = (sessionId, afterEventSeq) => {
    if (!sessionId) return;
    const cursor = new EnvelopeDeliveryCursor();
    cursor.reset(afterEventSeq);
    deliveryCursors.set(sessionId, cursor);
  };

  /** @param {import('./sessionCoreTypes.js').SessionEnvelope} event @param {string} sessionId */
  const shouldDeliverEvent = (event, sessionId) => getDeliveryCursor(sessionId).accept(event);

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
      void connect(sessionId, {
        isReconnect: true,
        historySnapshot: historySnapshotPendingSessionId === sessionId,
      });
    }, delay);
  };

  const disconnect = ({ preserveReconnectState = false } = {}) => {
    connectGeneration += 1;
    pendingSessionId = null;
    onDisconnect?.();
    if (!preserveReconnectState) {
      reconnectAttempts = 0;
      historySnapshotPendingSessionId = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const currentSocket = socket;
    socket = null;
    socketSessionId = null;
    currentSocket?.close();
  };

  /** @param {string} sessionId @param {{ isReconnect?: boolean, historySnapshot?: boolean }} [options] */
  const connect = async (sessionId, { isReconnect = false, historySnapshot = false } = {}) => {
    if (!sessionId) return;
    if (canReuseSessionSocket(sessionId, socketSessionId, socket)) return;
    if (pendingSessionId === sessionId) return;
    disconnect({ preserveReconnectState: isReconnect });
    if (historySnapshot) historySnapshotPendingSessionId = sessionId;
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
    const hasInitializedCursor = deliveryCursors.has(sessionId);
    const shouldRequestHistorySnapshot = historySnapshot
      || historySnapshotPendingSessionId === sessionId;
    const url = buildSessionSocketUrl(sessionId, {
      protocol: currentLocation.protocol,
      host: currentLocation.host,
      afterEventSeq: isReconnect || hasInitializedCursor ? lastEventSeq : null,
      historySnapshot: shouldRequestHistorySnapshot,
      ticket,
    });
    const nextSocket = createSocket(url);
    socketSessionId = sessionId;
    nextSocket.onopen = () => {
      console.debug('[WS] 连接建立', sessionId);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      sendHostToolsRegister(nextSocket, sessionId);
    };
    nextSocket.onmessage = (message) => {
      try {
        const event = /** @type {import('./sessionCoreTypes.js').SessionEnvelope} */ (JSON.parse(message.data));
        reconnectAttempts = 0;
        if (!shouldDeliverEvent(event, sessionId)) return;
        if (event.type === 'session.runtime' && !event.payload?.active_run) {
          historySnapshotPendingSessionId = null;
        }
        if (event.type === 'session.reconnect'
          && event.payload?.replay_source === 'active_run_snapshot'
          && event.payload?.phase === 'end') {
          historySnapshotPendingSessionId = null;
        }
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

  /**
   * 强制重建当前 session 的连接，用于消息列表重载后重新投影 active run。
   * 普通 connect 会复用已打开的 socket，因此这里必须先断开再连接。
   */
  /** @param {string} sessionId @param {{ historySnapshot?: boolean }} [options] */
  const reconnect = async (sessionId, { historySnapshot = false } = {}) => {
    if (!sessionId) return;
    disconnect({ preserveReconnectState: true });
    await connect(sessionId, { isReconnect: true, historySnapshot });
  };

  return {
    connect,
    reconnect,
    disconnect,
    getSocket: () => socket,
    getLastEventSeq,
    initializeSessionEventCursor,
  };
}
