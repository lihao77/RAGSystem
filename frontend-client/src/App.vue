<template>
  <div id="app">
    <a href="#main-content" class="skip-link">跳到主内容</a>
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
import { nextTick, onMounted, ref } from 'vue';
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

/** 桌宠快速对话：文本注入聊天输入框（Vue 受控 textarea 需派发 input 事件同步 v-model）。 */
const fillComposer = async (text) => {
  await nextTick();
  const input = document.querySelector('.message-composer textarea, main textarea, textarea');
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
};

onMounted(() => {
  themeStore.init();
  window.ragsystemDesktop?.onQuickAsk?.(async (text) => {
    if (router.currentRoute.value.path !== '/') await router.push('/');
    await fillComposer(String(text ?? ''));
  });
});
</script>

<style>
#app {
  position: relative;
  width: 100%;
  height: 100%;
}
</style>
