import { ref, unref, watch } from 'vue';

const RUNTIME_TABS = new Set(['execution', 'background', 'goal']);

export function useSessionRuntimeCenter(isWideScreen) {
  const activeTab = ref('execution');
  const mobileOpen = ref(false);

  function open(tab = 'execution') {
    if (RUNTIME_TABS.has(tab)) activeTab.value = tab;
    if (!unref(isWideScreen)) mobileOpen.value = true;
  }

  function closeMobile() {
    mobileOpen.value = false;
  }

  watch(() => Boolean(unref(isWideScreen)), (wide) => {
    if (wide) closeMobile();
  });

  return { activeTab, mobileOpen, open, closeMobile };
}

