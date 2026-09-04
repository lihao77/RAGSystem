import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { activeSessionId, notifySelectionChanged } from './sessionScope.js';

const STORAGE_KEY = 'selectedLLMModel';

/**
 * 选中的 LLM 模型单源：替代原 App.vue selectedLLM ref + props/emit 透传全链
 * + SessionContextBar/ChatViewV2/LLMSelector 各自 localStorage 读写。
 *
 * 两层语义：defaultLLM 是跨会话的个人默认（localStorage 持久化）；
 * sessionOverride 是会话维度覆盖层——恢复对话时由会话 metadata 的
 * _request_overrides 写入，仅在该会话激活期间生效，切走/新建即回落个人默认。
 * UI 与发送链路统一读 computed selectedLLM（覆盖优先）。
 */
export const useLlmStore = defineStore('llm', () => {
  const defaultLLM = ref(localStorage.getItem(STORAGE_KEY) || '');
  const sessionOverride = ref(null); // { sessionId, selectedLLM } | null

  const selectedLLM = computed(() => (
    sessionOverride.value && sessionOverride.value.sessionId === activeSessionId.value
      ? sessionOverride.value.selectedLLM
      : defaultLLM.value
  ));

  const setSelectedLLM = (value) => {
    const next = value || '';
    defaultLLM.value = next;
    localStorage.setItem(STORAGE_KEY, next);
    // 手动选择即用户新的个人默认；清掉当前会话覆盖，避免 effective 仍指向旧值
    if (sessionOverride.value && sessionOverride.value.sessionId === activeSessionId.value) {
      sessionOverride.value = null;
    }
    notifySelectionChanged();
  };

  // 自动失效清理（选择器防呆）：清个人默认但不通知——这不是用户选择，
  // 不应触发"选择即落库"把会话的有效恢复记录抹成默认。
  const discardStaleDefault = () => {
    defaultLLM.value = '';
    localStorage.setItem(STORAGE_KEY, '');
  };

  const applySessionOverride = (sessionId, value) => {
    if (!sessionId) return;
    sessionOverride.value = { sessionId, selectedLLM: value || '' };
  };

  const clearSessionOverride = (sessionId) => {
    const target = sessionId || activeSessionId.value;
    if (sessionOverride.value && sessionOverride.value.sessionId === target) {
      sessionOverride.value = null;
    }
  };

  return { selectedLLM, setSelectedLLM, discardStaleDefault, applySessionOverride, clearSessionOverride };
});
