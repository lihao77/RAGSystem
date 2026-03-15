<template>
  <div id="app">
    <RouterView v-slot="{ Component, route }">
      <Transition :name="transitionName">
        <component
          :is="Component"
          :key="route.path"
          :selected-llm="selectedLLM"
          :is-dark="isDark"
          @update:selectedLLM="selectedLLM = $event"
          @toggle-theme="toggleTheme"
        />
      </Transition>
    </RouterView>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import hljsDarkUrl from 'highlight.js/styles/github-dark.css?url';
import hljsLightUrl from 'highlight.js/styles/github.css?url';

const router = useRouter();

const isDark = ref(true);
const selectedLLM = ref('');
const transitionName = ref('slide-forward');

const routeDepth = {
  '/': 0,
  '/chat': 0,
  '/monitor': 1,
  '/agent-monitor': 1,
  '/agent-config': 1,
  '/mcp': 1,
  '/vector-library': 1,
  '/model-providers': 1,
};

const getDepth = (path) => {
  if (path.startsWith('/chat/')) return 0;
  return routeDepth[path] ?? 0;
};

router.beforeEach((to, from) => {
  const fromDepth = getDepth(from.path);
  const toDepth = getDepth(to.path);
  transitionName.value = toDepth >= fromDepth ? 'slide-forward' : 'slide-backward';
});

const toggleTheme = () => {
  isDark.value = !isDark.value;
  updateTheme();
};

const updateTheme = () => {
  const root = document.documentElement;
  if (isDark.value) {
    root.setAttribute('data-theme', 'dark');
  } else {
    root.setAttribute('data-theme', 'light');
  }
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light');

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

onMounted(() => {
  const savedTheme = localStorage.getItem('theme');
  isDark.value = savedTheme ? savedTheme === 'dark' : true;
  updateTheme();

  const savedLLM = localStorage.getItem('selectedLLMModel');
  if (savedLLM) {
    selectedLLM.value = savedLLM;
  }
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
