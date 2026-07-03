import { ref } from 'vue';
import { defineStore } from 'pinia';

const STORAGE_KEY = 'theme';

/**
 * 主题单源：isDark 唯一持有者，替代原 App.vue 本地 ref + setAttribute + localStorage，
 * 以及 ChartRenderer/MapRenderer 各自的 MutationObserver(data-theme) 监听。
 * 组件改用 storeToRefs(useThemeStore()) 订阅 isDark，主题变化时响应式重渲染。
 */
export const useThemeStore = defineStore('theme', () => {
  const isDark = ref(true);

  const apply = () => {
    document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light');
    localStorage.setItem(STORAGE_KEY, isDark.value ? 'dark' : 'light');
  };

  /** 应用启动时调用一次：从 localStorage 恢复并应用到 <html>。 */
  const init = () => {
    const saved = localStorage.getItem(STORAGE_KEY);
    isDark.value = saved ? saved === 'dark' : true;
    apply();
  };

  const toggle = () => {
    isDark.value = !isDark.value;
    apply();
  };

  return { isDark, init, toggle };
});
