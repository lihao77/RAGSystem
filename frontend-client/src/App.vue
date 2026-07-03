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
import { useThemeStore } from './stores/theme.js';

const router = useRouter();
const themeStore = useThemeStore();

const transitionName = ref('slide-forward');

const getRouteShellKey = (route) => route.matched[0]?.meta?.shellKey || route.meta?.shellKey || route.path;
const getRouteDepth = (targetRoute) => targetRoute.meta?.depth ?? 0;

router.beforeEach((to, from) => {
  const fromDepth = getRouteDepth(from);
  const toDepth = getRouteDepth(to);
  transitionName.value = toDepth >= fromDepth ? 'slide-forward' : 'slide-backward';
});

onMounted(() => {
  themeStore.init();
});
</script>

<style>
#app {
  position: relative;
  width: 100%;
  height: 100%;
}
</style>
