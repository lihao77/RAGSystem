import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { activeSessionId, notifySelectionChanged } from './sessionScope.js';

const STORAGE_KEY = 'thinkingLevel';

const VALID_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'on'];

/**
 * 思考档位单源（与 llm store 的 selectedLLM 同构，含会话维度覆盖层）。
 * defaultLevel 为个人默认（localStorage，空串 = 跟随 provider 配置）；
 * sessionOverride 由恢复对话时从会话 metadata._request_overrides 写入，
 * 仅在该会话激活期间生效。各档位为请求级覆盖，随每条消息下发；
 * 档位集合按 provider 不同（llm 包 describeThinking 返回），store 只做合法性兜底。
 */
export const useThinkingStore = defineStore('thinking', () => {
  const saved = localStorage.getItem(STORAGE_KEY) || '';
  const defaultLevel = ref(VALID_LEVELS.includes(saved) ? saved : '');
  const sessionOverride = ref(null); // { sessionId, thinkingLevel } | null

  const thinkingLevel = computed(() => (
    sessionOverride.value && sessionOverride.value.sessionId === activeSessionId.value
      ? sessionOverride.value.thinkingLevel
      : defaultLevel.value
  ));

  const setThinkingLevel = (value) => {
    const next = VALID_LEVELS.includes(value) ? value : '';
    defaultLevel.value = next;
    localStorage.setItem(STORAGE_KEY, next);
    if (sessionOverride.value && sessionOverride.value.sessionId === activeSessionId.value) {
      sessionOverride.value = null;
    }
    notifySelectionChanged();
  };

  // 自动失效清理（选择器防呆）：清个人默认但不通知——这不是用户选择，
  // 不应触发"选择即落库"把会话的有效恢复记录抹成默认。
  const discardStaleDefault = () => {
    defaultLevel.value = '';
    localStorage.setItem(STORAGE_KEY, '');
  };

  const applySessionOverride = (sessionId, value) => {
    if (!sessionId) return;
    const next = VALID_LEVELS.includes(value) ? value : '';
    sessionOverride.value = { sessionId, thinkingLevel: next };
  };

  const clearSessionOverride = (sessionId) => {
    const target = sessionId || activeSessionId.value;
    if (sessionOverride.value && sessionOverride.value.sessionId === target) {
      sessionOverride.value = null;
    }
  };

  const isOverride = computed(() => thinkingLevel.value !== '');

  return { thinkingLevel, setThinkingLevel, discardStaleDefault, isOverride, applySessionOverride, clearSessionOverride };
});
