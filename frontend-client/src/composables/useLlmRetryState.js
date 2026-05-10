import { ref } from 'vue';

const formatRetryCountdownText = (state, clockMs) => {
  if (!state?.nextRetryAt) return '';
  const remainingMs = Math.max(0, state.nextRetryAt - clockMs);
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  return remainingSeconds > 0 ? `${remainingSeconds} 秒后重试` : '即将重试';
};

const buildLlmRetryStatusText = (state, clockMs) => {
  if (!state) return '';
  const countdown = formatRetryCountdownText(state, clockMs);
  const errorHint = state.error ? `（${state.error}）` : '';
  return `模型调用失败${errorHint}，准备第 ${state.nextAttempt}/${state.maxAttempts} 次重试${countdown ? `，${countdown}` : ''}`;
};

/**
 * LLM 重试状态、倒计时和消息状态同步。
 */
export function useLlmRetryState(deps) {
  const llmRetryState = ref(null);
  const retryClockMs = ref(Date.now());
  let llmRetryTimer = null;

  const syncActiveMessageRetryStatus = () => {
    const currentMsg = deps.activeRun.assistantMsgIndex >= 0
      ? deps.messages.value[deps.activeRun.assistantMsgIndex]
      : null;
    if (!currentMsg) return;
    if (!Array.isArray(currentMsg.status)) currentMsg.status = [];
    const retryIndex = currentMsg.status.findIndex(item => item.kind === 'llm_retry');
    if (!llmRetryState.value) {
      if (retryIndex >= 0) currentMsg.status.splice(retryIndex, 1);
      return;
    }
    const retryStatus = {
      kind: 'llm_retry',
      type: 'warning',
      content: buildLlmRetryStatusText(llmRetryState.value, retryClockMs.value),
    };
    if (retryIndex >= 0) {
      currentMsg.status.splice(retryIndex, 1, retryStatus);
    } else {
      currentMsg.status.push(retryStatus);
    }
  };

  const stopRetryTicker = () => {
    if (llmRetryTimer != null) {
      clearInterval(llmRetryTimer);
      llmRetryTimer = null;
    }
  };

  const ensureRetryTicker = () => {
    if (llmRetryTimer != null) return;
    llmRetryTimer = window.setInterval(() => {
      retryClockMs.value = Date.now();
      if (!llmRetryState.value) {
        stopRetryTicker();
        return;
      }
      syncActiveMessageRetryStatus();
    }, 250);
  };

  const setLlmRetryState = (retryData) => {
    llmRetryState.value = retryData ? {
      ...retryData,
      nextRetryAt: Date.now() + Math.max(0, retryData.waitMs || 0),
    } : null;
    retryClockMs.value = Date.now();
    if (llmRetryState.value) {
      ensureRetryTicker();
    } else {
      stopRetryTicker();
    }
    syncActiveMessageRetryStatus();
  };

  const clearLlmRetryState = () => {
    llmRetryState.value = null;
    retryClockMs.value = Date.now();
    syncActiveMessageRetryStatus();
    stopRetryTicker();
  };

  const formatRetryCountdown = (state) => formatRetryCountdownText(state, retryClockMs.value);

  return {
    llmRetryState,
    formatRetryCountdown,
    setLlmRetryState,
    clearLlmRetryState,
  };
}
