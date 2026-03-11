<template>
  <div id="app">
    <Transition :name="transitionName">
      <component
        :key="currentRoute"
        :is="currentView"
        :selected-llm="selectedLLM"
        :is-dark="isDark"
        @update:selectedLLM="selectedLLM = $event"
        @toggle-theme="toggleTheme"
        @navigate="handleNavigate"
      />
    </Transition>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import ChatViewV2 from './views/ChatViewV2.vue';
import AgentMonitor from './views/AgentMonitor.vue';
import AgentConfig from './views/AgentConfig.vue';
import MCPManager from './views/MCPManager.vue';
import VectorLibraryManager from './views/VectorLibraryManager.vue';
// highlight.js 主题随亮暗模式动态切换，避免固定主题在反色模式下产生行级色差
import hljsDarkUrl from 'highlight.js/styles/github-dark.css?url';
import hljsLightUrl from 'highlight.js/styles/github.css?url';

const isDark = ref(true);
const selectedLLM = ref('');
const currentRoute = ref(window.location.pathname);
const transitionName = ref('slide-forward');

// 路由层级：数值越大越靠右
const routeDepth = {
  '/': 0,
  '/chat': 0,
  '/monitor': 1,
  '/agent-monitor': 1,
  '/agent-config': 1,
  '/mcp': 1,
  '/vector-library': 1,
};

const getDepth = (path) => {
  if (path.startsWith('/chat/')) return 0;
  return routeDepth[path] ?? 0;
};

// 简单路由映射
const routes = {
  '/': ChatViewV2,
  '/monitor': AgentMonitor,
  '/agent-monitor': AgentMonitor,
  '/agent-config': AgentConfig,
  '/mcp': MCPManager,
  '/vector-library': VectorLibraryManager,
};

const currentView = computed(() => {
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
    const from = getDepth(currentRoute.value);
    const to = getDepth(path);
    transitionName.value = to >= from ? 'slide-forward' : 'slide-backward';
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

  // 动态切换 highlight.js 主题，避免固定主题在反色模式下产生行级色差
  const existingLink = document.getElementById('hljs-theme');
  const href = isDark.value ? hljsDarkUrl : hljsLightUrl;
  if (existingLink) {
    existingLink.setAttribute('href', href);
  } else {
    const link = document.createElement('link');
    link.id = 'hljs-theme';
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
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
#app {
  position: relative;
  overflow: hidden;
  width: 100%;
  height: 100%;
}

/* 向右进入（从右滑入 + 淡入） */
.slide-forward-enter-active,
.slide-forward-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
  position: absolute;
  width: 100%;
  height: 100%;
  top: 0;
  left: 0;
}
.slide-forward-enter-from { transform: translateX(40px); opacity: 0; }
.slide-forward-enter-to   { transform: translateX(0);    opacity: 1; }
.slide-forward-leave-from { transform: translateX(0);    opacity: 1; }
.slide-forward-leave-to   { transform: translateX(-40px); opacity: 0; }

/* 向左返回（从左滑入 + 淡入） */
.slide-backward-enter-active,
.slide-backward-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
  position: absolute;
  width: 100%;
  height: 100%;
  top: 0;
  left: 0;
}
.slide-backward-enter-from { transform: translateX(-40px); opacity: 0; }
.slide-backward-enter-to   { transform: translateX(0);     opacity: 1; }
.slide-backward-leave-from { transform: translateX(0);     opacity: 1; }
.slide-backward-leave-to   { transform: translateX(40px);  opacity: 0; }
</style>
