import { respondInteraction as respondInteractionApi } from '../api/session.js';

const WS_OPEN = 1;
const INTERACTION_ACK_TIMEOUT_MS = 8000;
const INTERACTION_ACK_TIMEOUT_CODE = 'INTERACTION_ACK_TIMEOUT';
const INTERACTION_REJECTED_CODE = 'INTERACTION_REJECTED';

const isOpenWebSocket = (ws) => !!ws && ws.readyState === WS_OPEN;

const buildInteractionPayload = (response) => {
  if (response.kind === 'user_input') {
    return { kind: 'user_input', phase: 'responded', value: String(response.value ?? '') };
  }
  return {
    kind: 'approval',
    phase: 'responded',
    approved: !!response.approved,
    message: response.message,
  };
};

export function createSessionInteractionController({
  getCurrentSessionId,
  getSocket,
  respondHttp = respondInteractionApi,
  ackTimeoutMs = INTERACTION_ACK_TIMEOUT_MS,
}) {
  const pendingInteractions = new Map();
  const handledRequiredInteractions = new Set();

  const clearPending = (callId) => {
    const pending = pendingInteractions.get(callId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    pendingInteractions.delete(callId);
    return pending;
  };

  const hasPending = (callId) => pendingInteractions.has(callId);

  const resolve = (callId) => {
    const pending = clearPending(callId);
    if (!pending) return false;
    pending.resolve();
    return true;
  };

  const reject = (callId, message) => {
    const pending = clearPending(callId);
    if (!pending) return false;
    const error = new Error(message || '交互提交失败');
    error.code = INTERACTION_REJECTED_CODE;
    pending.reject(error);
    return true;
  };

  const submitWs = (ws, sessionId, callId, payload) => new Promise((resolvePending, rejectPending) => {
    if (!callId) {
      rejectPending(new Error('交互请求缺少 call_id'));
      return;
    }
    const existing = clearPending(callId);
    existing?.reject(new Error('交互已重新提交'));
    const timer = setTimeout(() => {
      pendingInteractions.delete(callId);
      const error = new Error('交互提交确认超时');
      error.code = INTERACTION_ACK_TIMEOUT_CODE;
      rejectPending(error);
    }, ackTimeoutMs);
    pendingInteractions.set(callId, { resolve: resolvePending, reject: rejectPending, timer });
    try {
      ws.send(JSON.stringify({ type: 'interaction', session_id: sessionId, call_id: callId, payload }));
    } catch (error) {
      clearPending(callId);
      rejectPending(error);
    }
  });

  const submitHttp = async (sessionId, interactionId, response) => {
    if (response.kind === 'user_input') {
      await respondHttp(sessionId, interactionId, {
        kind: 'user_input',
        value: String(response.value ?? ''),
      });
      return;
    }
    await respondHttp(sessionId, interactionId, {
      kind: 'approval',
      approved: !!response.approved,
      message: response.message,
    });
  };

  const respond = async (interactionId, response) => {
    const sessionId = getCurrentSessionId();
    const socket = getSocket();
    if (isOpenWebSocket(socket)) {
      try {
        await submitWs(socket, sessionId, interactionId, buildInteractionPayload(response));
        return;
      } catch (error) {
        if (error?.code === INTERACTION_ACK_TIMEOUT_CODE || error?.code === INTERACTION_REJECTED_CODE) {
          throw error;
        }
        console.warn('交互 WS 提交失败，降级 HTTP:', error);
      }
    }
    await submitHttp(sessionId, interactionId, response);
  };

  const rememberRequired = (kind, interactionId) => {
    if (!interactionId) return true;
    const key = `${kind || 'unknown'}:${interactionId}`;
    if (handledRequiredInteractions.has(key)) return false;
    handledRequiredInteractions.add(key);
    return true;
  };

  const reset = () => {
    handledRequiredInteractions.clear();
    for (const pending of pendingInteractions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('会话已切换，交互提交已取消'));
    }
    pendingInteractions.clear();
  };

  return { respond, hasPending, resolve, reject, rememberRequired, reset };
}
