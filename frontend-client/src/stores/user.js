import { ref } from 'vue';
import { defineStore } from 'pinia';

const STORAGE_KEY = 'userId';

/**
 * 当前用户单源：替代散落的 localStorage.getItem('userId')。
 */
export const useUserStore = defineStore('user', () => {
  const userId = ref((localStorage.getItem(STORAGE_KEY) || '').trim());

  const setUserId = (value) => {
    const next = (value || '').trim();
    userId.value = next;
    if (next) {
      localStorage.setItem(STORAGE_KEY, next);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  return { userId, setUserId };
});
