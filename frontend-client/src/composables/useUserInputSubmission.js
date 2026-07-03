import { respondInteraction } from '../api/session.js';

/**
 * user_input 提交通道：WS 主路径（带 ack 等待）+ HTTP 降级 + pending 管理。
 *
 * 从 useSessionRunStream 抽出的自洽子系统。resolveSubmission/rejectSubmission 供
 * 事件分发器在收到 interaction ack/reject 时兑现/拒绝 pending；reset 供切会话时清理。
 *
 * @param {Object} deps
 * @param {Function} deps.getWS - () => WebSocket | null
 */
const USER_INPUT_ACK_TIMEOUT_MS = 8000;
const USER_INPUT_ACK_TIMEOUT_CODE = 'USER_INPUT_ACK_TIMEOUT';
export const USER_INPUT_REJECTED_CODE = 'USER_INPUT_REJECTED';

const isOpenWebSocket = (ws) => {
  if (!ws) return false;
  const openState = typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1;
  return ws.readyState === openState;
};

export function useUserInputSubmission({ getWS }) {
  const _pending = new Map();

  const clearPending = (inputId) => {
    const pending = _pending.get(inputId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    _pending.delete(inputId);
    return pending;
  };

  const hasPending = (inputId) => _pending.has(inputId);

  const resolveSubmission = (inputId) => {
    const pending = clearPending(inputId);
    if (!pending) return false;
    pending.resolve();
    return true;
  };

  const rejectSubmission = (inputId, errMsg) => {
    const pending = clearPending(inputId);
    if (!pending) return false;
    const error = new Error(errMsg || '用户输入提交失败');
    error.code = USER_INPUT_REJECTED_CODE;
    pending.reject(error);
    return true;
  };

  const submitHttp = async (sessionId, inputId, value) => {
    await respondInteraction(sessionId, inputId, { kind: 'user_input', value });
  };

  const submitWs = (ws, sessionId, inputId, value) => new Promise((resolve, reject) => {
    if (!inputId) {
      reject(new Error('用户输入请求缺少 call_id'));
      return;
    }
    const existing = clearPending(inputId);
    if (existing) {
      existing.reject(new Error('用户输入已重新提交'));
    }
    const timer = setTimeout(() => {
      _pending.delete(inputId);
      const error = new Error('用户输入提交确认超时');
      error.code = USER_INPUT_ACK_TIMEOUT_CODE;
      reject(error);
    }, USER_INPUT_ACK_TIMEOUT_MS);
    _pending.set(inputId, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ type: 'interaction', session_id: sessionId, call_id: inputId, payload: { kind: 'user_input', phase: 'responded', value } }));
    } catch (error) {
      clearPending(inputId);
      reject(error);
    }
  });

  const submitForSession = async (sessionId, inputId, value) => {
    const normalizedValue = String(value ?? '');
    const ws = getWS?.();
    if (isOpenWebSocket(ws)) {
      try {
        await submitWs(ws, sessionId, inputId, normalizedValue);
        return;
      } catch (error) {
        if (error?.code === USER_INPUT_ACK_TIMEOUT_CODE || error?.code === USER_INPUT_REJECTED_CODE) {
          throw error;
        }
        console.warn('用户输入 WS 提交失败，降级 HTTP:', error);
      }
    }
    await submitHttp(sessionId, inputId, normalizedValue);
  };

  const reset = () => {
    for (const pending of _pending.values()) {
      clearTimeout(pending.timer);
      pending.reject?.(new Error('会话已切换，用户输入提交已取消'));
    }
    _pending.clear();
  };

  return {
    submitForSession,
    hasPending,
    resolveSubmission,
    rejectSubmission,
    reset,
  };
}
