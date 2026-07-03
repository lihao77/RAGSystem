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
  root.setAttribute('data-theme', isDark.value ? 'dark' : 'light');
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light');
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
