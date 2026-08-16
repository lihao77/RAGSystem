import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

const STORAGE_KEY = 'thinkingLevel';

const VALID_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'on'];

/**
 * 思考档位单源（与 llm store 的 selectedLLM 同构）。
 * 空串 = 跟随 provider 配置（默认）；各档位为请求级覆盖，随每条消息下发。
 * 档位集合按 provider 不同（llm 包 describeThinking 返回），store 只做合法性兜底。
 */
export const useThinkingStore = defineStore('thinking', () => {
  const saved = localStorage.getItem(STORAGE_KEY) || '';
  const thinkingLevel = ref(VALID_LEVELS.includes(saved) ? saved : '');

  const setThinkingLevel = (value) => {
    const next = VALID_LEVELS.includes(value) ? value : '';
    thinkingLevel.value = next;
    localStorage.setItem(STORAGE_KEY, next);
  };

  const isOverride = computed(() => thinkingLevel.value !== '');

  return { thinkingLevel, setThinkingLevel, isOverride };
});
