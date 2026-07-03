import { ref } from 'vue';
import { defineStore } from 'pinia';

const STORAGE_KEY = 'selectedLLMModel';

/**
 * 选中的 LLM 模型单源：替代原 App.vue selectedLLM ref + props/emit 透传全链
 * + SessionContextBar/ChatViewV2/LLMSelector 各自 localStorage 读写。
 */
export const useLlmStore = defineStore('llm', () => {
  const selectedLLM = ref(localStorage.getItem(STORAGE_KEY) || '');

  const setSelectedLLM = (value) => {
    const next = value || '';
    selectedLLM.value = next;
    localStorage.setItem(STORAGE_KEY, next);
  };

  return { selectedLLM, setSelectedLLM };
});
