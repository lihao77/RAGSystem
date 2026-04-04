<template>
  <div id="app">
    <div class="mouse-glow" aria-hidden="true"></div>
    <RouterView v-slot="{ Component, route }">
      <Transition :name="transitionName" mode="out-in">
        <component
          v-if="Component"
          :is="Component"
          :key="getRouteShellKey(route)"
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
  '/monitor': 0,
  '/agent-monitor': 0,
  '/agent-config': 0,
  '/mcp': 0,
  '/vector-library': 0,
  '/model-providers': 0,
};

const getDepth = (path) => {
  if (path.startsWith('/chat/')) return 0;
  return routeDepth[path] ?? 0;
};

const getRouteShellKey = (route) => route.matched[0]?.meta?.shellKey || route.meta?.shellKey || route.path;

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

  const root = document.documentElement;
  const mouseGlow = document.querySelector('.mouse-glow');
  window.addEventListener('mousemove', (e) => {
    root.style.setProperty('--mouse-x', `${e.clientX}px`);
    root.style.setProperty('--mouse-y', `${e.clientY}px`);
    if (mouseGlow) mouseGlow.style.opacity = '1';
  }, { passive: true });
  window.addEventListener('mouseleave', () => {
    if (mouseGlow) mouseGlow.style.opacity = '0';
  });
});
</script>

<style>
#app {
  position: relative;
  width: 100%;
  height: 100%;
}

/* 鼠标光晕 — 跟随鼠标的柔和照亮效果 */
.mouse-glow {
  position: fixed;
  left: 0;
  top: 0;
  pointer-events: none;
  width: var(--glow-size);
  height: var(--glow-size);
  border-radius: 50%;
  background: radial-gradient(circle, var(--glow-color) 0%, transparent 70%);
  transform: translate(
    calc(var(--mouse-x, -9999px) - 50%),
    calc(var(--mouse-y, -9999px) - 50%)
  );
  z-index: 0;
  opacity: 0;
  transition: opacity 0.4s ease;
  will-change: transform;
}

/* 向右进入（从右滑入 + 淡入） - Apple style */
.slide-forward-enter-active,
.slide-forward-leave-active {
  transition: transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              opacity 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  position: absolute;
  width: 100%;
  height: 100%;
  top: 0;
  left: 0;
}
.slide-forward-enter-from { transform: translateX(60px) scale(0.98); opacity: 0; }
.slide-forward-enter-to   { transform: translateX(0) scale(1);       opacity: 1; }
.slide-forward-leave-from { transform: translateX(0) scale(1);       opacity: 1; }
.slide-forward-leave-to   { transform: translateX(-60px) scale(0.98); opacity: 0; }

/* 向左返回（从左滑入 + 淡入） - Apple style */
.slide-backward-enter-active,
.slide-backward-leave-active {
  transition: transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              opacity 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  position: absolute;
  width: 100%;
  height: 100%;
  top: 0;
  left: 0;
}
.slide-backward-enter-from { transform: translateX(-60px) scale(0.98); opacity: 0; }
.slide-backward-enter-to   { transform: translateX(0) scale(1);        opacity: 1; }
.slide-backward-leave-from { transform: translateX(0) scale(1);        opacity: 1; }
.slide-backward-leave-to   { transform: translateX(60px) scale(0.98);  opacity: 0; }
</style>
