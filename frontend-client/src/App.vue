<template>
  <div id="app">
    <component
      :is="currentView"
      :selected-llm="selectedLLM"
      :is-dark="isDark"
      @update:selectedLLM="selectedLLM = $event"
      @toggle-theme="toggleTheme"
      @navigate="handleNavigate"
    />
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import ChatViewV2 from './views/ChatViewV2.vue';
import AgentMonitor from './views/AgentMonitor.vue';
import 'highlight.js/styles/github-dark.css';

const isDark = ref(true);
const selectedLLM = ref('');
const currentRoute = ref(window.location.pathname);

// 简单路由映射
const routes = {
  '/': ChatViewV2,
  '/monitor': AgentMonitor,
  '/agent-monitor': AgentMonitor
};

const currentView = computed(() => {
  // 支持 /chat/:sessionId 路由
  if (currentRoute.value.startsWith('/chat/')) {
    return ChatViewV2;
  }
  return routes[currentRoute.value] || ChatViewV2;
});

const toggleTheme = () => {
  isDark.value = !isDark.value;
  updateTheme();
};

const handleNavigate = (path) => {
  if (path && path !== currentRoute.value) {
    currentRoute.value = path;
    window.history.pushState({}, '', path);
  }
};

const updateTheme = () => {
  const root = document.documentElement;
  if (isDark.value) {
    root.setAttribute('data-theme', 'dark');
  } else {
    root.setAttribute('data-theme', 'light');
  }
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light');
};

// 监听浏览器前进后退
const handlePopState = () => {
  currentRoute.value = window.location.pathname;
};

onMounted(() => {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) {
    isDark.value = savedTheme === 'dark';
  } else {
    isDark.value = true;
  }
  updateTheme();

  const savedLLM = localStorage.getItem('selectedLLMModel');
  if (savedLLM) {
    selectedLLM.value = savedLLM;
  }

  window.addEventListener('popstate', handlePopState);
});
</script>

<style>
/* App.vue 不再需要控制栏样式，已移到 ChatViewV2 */
</style>
