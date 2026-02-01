<template>
  <div id="app">
    <ChatView v-if="!useV2" :selected-llm="selectedLLM" :use-v2="useV2" :is-dark="isDark"
      @update:selectedLLM="selectedLLM = $event" @toggle-version="toggleVersion" @toggle-theme="toggleTheme" />
    <ChatViewV2 v-else :selected-llm="selectedLLM" :use-v2="useV2" :is-dark="isDark"
      @update:selectedLLM="selectedLLM = $event" @toggle-version="toggleVersion" @toggle-theme="toggleTheme" />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import ChatView from './views/ChatView.vue';
import ChatViewV2 from './views/ChatViewV2.vue';
import 'highlight.js/styles/github-dark.css';

const isDark = ref(true);
const useV2 = ref(false);
const selectedLLM = ref('');

const toggleTheme = () => {
  isDark.value = !isDark.value;
  updateTheme();
};

const toggleVersion = () => {
  useV2.value = !useV2.value;
  localStorage.setItem('useV2', useV2.value ? 'true' : 'false');
};

const updateTheme = () => {
  const root = document.documentElement;
  if (isDark.value) {
    root.setAttribute('data-theme', 'dark');
  } else {
    root.setAttribute('data-theme', 'light');
  }
  // 保存用户偏好
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light');
};

onMounted(() => {
  // 检查本地存储或系统偏好
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) {
    isDark.value = savedTheme === 'dark';
  } else {
    // 默认暗色模式
    isDark.value = true;
  }
  updateTheme();

  // 检查版本偏好
  const savedVersion = localStorage.getItem('useV2');
  if (savedVersion) {
    useV2.value = savedVersion === 'true';
  }

  // 加载已选择的 LLM
  const savedLLM = localStorage.getItem('selectedLLMModel');
  if (savedLLM) {
    selectedLLM.value = savedLLM;
  }
});
</script>

<style>
/* App.vue 不再需要控制栏样式，已移到 ChatViewV2 */
</style>
