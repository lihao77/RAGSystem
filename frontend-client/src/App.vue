<template>
  <div id="app">
    <GlobalToast />
    <GlobalConfirmDialog />
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
import GlobalToast from './components/GlobalToast.vue';
import GlobalConfirmDialog from './components/GlobalConfirmDialog.vue';
import hljsDarkUrl from 'highlight.js/styles/github-dark.css?url';
import hljsLightUrl from 'highlight.js/styles/github.css?url';

const router = useRouter();

const isDark = ref(true);
const selectedLLM = ref('');
const transitionName = ref('slide-forward');

const getRouteShellKey = (route) => route.matched[0]?.meta?.shellKey || route.meta?.shellKey || route.path;
const getRouteDepth = (targetRoute) => targetRoute.meta?.depth ?? 0;

router.beforeEach((to, from) => {
  const fromDepth = getRouteDepth(from);
  const toDepth = getRouteDepth(to);
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
});
</script>

<style>
#app {
  position: relative;
  width: 100%;
  height: 100%;
}
</style>
